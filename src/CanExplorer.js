import React, { Component } from 'react';
import Moment from 'moment';
import PropTypes from 'prop-types';

import {USE_UNLOGGER, PART_SEGMENT_LENGTH} from './config';
import * as GithubAuth from './api/github-auth';
import cx from 'classnames';

import Modal from './components/Modals/baseModal';
import DBC from './models/can/dbc';
import Meta from './components/meta';
import Explorer from './components/explorer';
import * as Routes from './api/routes';
import SaveDbcModal from './components/SaveDbcModal';
import LoadDbcModal from './components/LoadDbcModal';
const CanFetcher = require('./workers/can-fetcher.worker.js');
const MessageParser = require("./workers/message-parser.worker.js");
const CanOffsetFinder = require('./workers/can-offset-finder.worker.js');
import debounce from './utils/debounce';
import EditMessageModal from './components/EditMessageModal';
import LoadingBar from './components/LoadingBar';
import {persistDbc} from './api/localstorage';
import OpenDbc from './api/opendbc';
import UnloggerClient from './api/unlogger';
import * as ObjectUtils from './utils/object';
import {hash} from './utils/string';

export default class CanExplorer extends Component {
    static propTypes = {
        dongleId: PropTypes.string.isRequired,
        name: PropTypes.string.isRequired,
        dbc: PropTypes.instanceOf(DBC),
        dbcFilename: PropTypes.string,
        githubAuthToken: PropTypes.string,
        autoplay: PropTypes.bool,
        max: PropTypes.number,
        url: PropTypes.string,
    };

    constructor(props) {
        super(props);
        this.state = {
            messages: {},
            selectedMessages: [],
            route: {},
            canFrameOffset: -1,
            firstCanTime: 0,
            selectedMessage: null,
            currentParts: [0,0],
            showLoadDbc: false,
            showSaveDbc: false,
            showEditMessageModal: false,
            editMessageModalMessage: null,
            dbc: new DBC(),
            dbcFilename: 'New_DBC',
            dbcLastSaved: null,
            seekTime: 0,
            seekIndex: 0,
            maxByteStateChangeCount: 0,
            isLoading: true,
            partsLoaded: 0,
            spawnWorkerHash: null,
        };
        this.openDbcClient = new OpenDbc(props.githubAuthToken);
        if(USE_UNLOGGER) {
          this.unloggerClient = new UnloggerClient();
        }

        this.showLoadDbc = this.showLoadDbc.bind(this);
        this.hideLoadDbc = this.hideLoadDbc.bind(this);
        this.showSaveDbc = this.showSaveDbc.bind(this);
        this.hideSaveDbc = this.hideSaveDbc.bind(this);
        this.showEditMessageModal = this.showEditMessageModal.bind(this);
        this.hideEditMessageModal = this.hideEditMessageModal.bind(this);
        this.onDbcSelected = this.onDbcSelected.bind(this);
        this.onDbcSaved = this.onDbcSaved.bind(this);
        this.onConfirmedSignalChange = this.onConfirmedSignalChange.bind(this);
        this.onPartChange = this.onPartChange.bind(this);
        this.onMessageFrameEdited = this.onMessageFrameEdited.bind(this);
        this.onSeek = this.onSeek.bind(this);
        this.onUserSeek = this.onUserSeek.bind(this);
        this.onMessageSelected = this.onMessageSelected.bind(this);
        this.onMessageUnselected = this.onMessageUnselected.bind(this);
        this.initCanData = this.initCanData.bind(this);
        this.updateSelectedMessages = this.updateSelectedMessages.bind(this);
        this.showingModal = this.showingModal.bind(this);
    }

    componentWillMount() {
      const {dongleId, name} = this.props;
      Routes.fetchRoutes(dongleId).then((routes) => {
        if(routes && routes[name]) {
          const route = routes[name];

          const newState = {route, currentParts: [0, Math.min(route.proclog - 1, PART_SEGMENT_LENGTH - 1)]};
          if(this.props.dbc !== undefined) {
            newState.dbc = this.props.dbc;
            newState.dbcFilename = this.props.dbcFilename;
          }
          this.setState(newState, this.initCanData);
        } else if(this.props.max && this.props.url) {
          const {max, url} = this.props;
          const route = {fullname: name, proclog: max, url: url};
          this.setState({route, currentParts: [0, Math.min(max - 1, PART_SEGMENT_LENGTH - 1)]}, this.initCanData);
        }
      });
    }

    initCanData() {
      const {route} = this.state;

      const offsetFinder = new CanOffsetFinder();
      offsetFinder.postMessage({partCount: route.proclog,
                                base: route.url});

      offsetFinder.onmessage = (e) => {
        const {canFrameOffset, firstCanTime} = e.data;

        this.setState({canFrameOffset, firstCanTime}, () => {
          this.spawnWorker(this.state.currentParts);
        });
      };
    }

    onDbcSelected(dbcFilename, dbc) {
      const {route} = this.state;
      this.hideLoadDbc();
      persistDbc(route.fullname,
                 {dbcFilename, dbc});
      this.setState({dbc,
                     dbcFilename,
                     partsLoaded: 0,
                     selectedMessage: null,
                     messages: {}}, () => {
        const {route} = this.state;

        // Pass DBC text to webworker b/c can't pass instance of es6 class
        this.spawnWorker(this.state.currentParts);
      });
    }

    onDbcSaved(dbcFilename) {
      const dbcLastSaved = Moment();
      this.setState({dbcLastSaved, dbcFilename})
      this.hideSaveDbc();
    }

    spawnWorker(parts, options) {
      // options is object of {part, prevMsgEntries, spawnWorkerHash, prepend}
      if(!this.state.isLoading) {
        this.setState({isLoading: true});
      }
      const [minPart, maxPart] = parts;
      let part = minPart, prevMsgEntries = {}, prepend = false, spawnWorkerHash;
      if(options) {
        if(options.part) part = options.part;
        if(options.prevMsgEntries) prevMsgEntries = options.prevMsgEntries;
        if(options.spawnWorkerHash) {
          spawnWorkerHash = options.spawnWorkerHash;
        }
      }
      if(!spawnWorkerHash) {
        spawnWorkerHash = hash(Math.random().toString(16));
        this.setState({spawnWorkerHash});
      }

      if(part === minPart) {
        this.setState({partsLoaded: 0});
      }

      const {dbc, dbcFilename, route, firstCanTime, canFrameOffset} = this.state;
      var worker = new CanFetcher();

      worker.onmessage = (e) => {
        if(spawnWorkerHash !== this.state.spawnWorkerHash) {
          // Parts changed, stop spawning workers.
          return;
        }

        const {messages} = this.state;
        if(this.state.dbcFilename != dbcFilename) {
          // DBC changed while this worker was running
          // -- don't update messages and halt recursion.
          return;
        }

        const {newMessages, maxByteStateChangeCount} = e.data;
        if(maxByteStateChangeCount > this.state.maxByteStateChangeCount) {
          this.setState({maxByteStateChangeCount});
        }

        for(var key in newMessages) {
          if (key in messages) {
            messages[key].entries = messages[key].entries.concat(newMessages[key].entries);
          } else {
            messages[key] = newMessages[key];
            messages[key].signals = this.state.dbc.getSignals(messages[key].address);
            messages[key].frame = this.state.dbc.messages.get(messages[key].address);
          }
        }

        const prevMsgEntries = {};
        for(let key in newMessages) {
          const msg = newMessages[key];
          prevMsgEntries[key] = msg.entries[msg.entries.length - 1];
        }

        this.setState({messages,
                       partsLoaded: this.state.partsLoaded + 1}, () => {
          if(part < maxPart) {
            this.spawnWorker(parts, {part: part + 1, prevMsgEntries, spawnWorkerHash, prepend});
          } else {
            this.setState({isLoading: false});
          }
        })
      }

      worker.postMessage({dbcText: dbc.text(),
                          base: route.url,
                          num: part,
                          canStartTime: firstCanTime - canFrameOffset,
                          prevMsgEntries
                        });
    }

    showingModal() {
      const {
        showLoadDbc,
        showSaveDbc,
        showAddSignal,
        showEditMessageModal,
      } = this.state;
      return showLoadDbc || showSaveDbc || showAddSignal || showEditMessageModal;
    }

    showLoadDbc() {
      this.setState({showLoadDbc: true});
    }

    hideLoadDbc() {
      this.setState({showLoadDbc: false});
    }

    showSaveDbc() {
      this.setState({showSaveDbc: true})
    }

    hideSaveDbc() {
      this.setState({showSaveDbc: false})
    }

    onConfirmedSignalChange(message) {
      const signals = message.signals;
      const {dbc, dbcFilename, route} = this.state;

      dbc.setSignals(message.address, message.signals);
      persistDbc(route.fullname,
                 {dbcFilename, dbc});

      this.setState({dbc, isLoading: true});

      var worker = new MessageParser();
      worker.onmessage = (e) => {
        const newMessage = e.data;
        newMessage.signals = dbc.getSignals(newMessage.address);
        newMessage.frame = dbc.messages.get(newMessage.address);

        const messages = {};
        Object.assign(messages, this.state.messages);
        messages[message.id] = newMessage;
        this.setState({messages, isLoading: false})
      }

      worker.postMessage({message,
                          dbcText: dbc.text(),
                          canStartTime: this.state.firstCanTime});
    }

    partChangeDebounced = debounce(() => {
        const {currentParts} = this.state;
        this.spawnWorker(currentParts);
      }, 500);

    onPartChange(part) {
      let {currentParts, partsLoaded, canFrameOffset, route, messages} = this.state;
      if(canFrameOffset === -1 || part + PART_SEGMENT_LENGTH >= route.proclog) {
        return
      }

      // determine new parts to load, whether to prepend or append
      const currentPartSpan = currentParts[1] - currentParts[0] + 1;

      // update current parts
      currentParts = [part, part + currentPartSpan - 1];

      // update messages to only preserve entries in new part range
      const messagesKvPairs = Object.entries(messages)
        .map(([messageId, message]) =>
            [messageId, {...message,
                         entries: []
                        }
            ]);
      messages = ObjectUtils.fromArray(messagesKvPairs);

      // update state then load new parts
      this.setState({currentParts, messages, seekTime: part * 60}, this.partChangeDebounced);
    }

    showEditMessageModal(msgKey) {
      const msg = this.state.messages[msgKey];
      if(!msg.frame) {
        msg.frame = this.state.dbc.createFrame(msg.address);
      }


      this.setState({showEditMessageModal: true,
                     editMessageModalMessage: msgKey,
                     messages: this.state.messages});
    }

    hideEditMessageModal() {
      this.setState({showEditMessageModal: false});
    }

    onMessageFrameEdited(messageFrame) {
      const {messages,
             route,
             dbcFilename,
             dbc,
             editMessageModalMessage} = this.state;

      const message = Object.assign({}, messages[editMessageModalMessage]);
      message.frame = messageFrame;
      dbc.messages.set(messageFrame.id, messageFrame);
      persistDbc(route.fullname,
                 {dbcFilename, dbc});

      messages[editMessageModalMessage] = message;
      this.setState({messages});
      this.hideEditMessageModal();
    }

    onSeek(seekIndex, seekTime) {
      this.setState({seekIndex, seekTime});
    }

    onUserSeek(seekTime) {
      if(USE_UNLOGGER) {
        this.unloggerClient.seek(this.props.dongleId, this.props.name, seekTime);
      }

      const msg = this.state.messages[this.state.selectedMessage];
      let seekIndex;
      if(msg) {
        seekIndex = msg.entries.findIndex((e) => e.relTime >= seekTime);
        if(seekIndex === -1) {
          seekIndex = 0
        }
      } else {
        seekIndex = 0
      }

      this.setState({seekIndex, seekTime});
    }

    onMessageSelected(msgKey) {
      let {seekTime, seekIndex, messages} = this.state;
      const msg = messages[msgKey];

      if(seekTime > 0 && msg.entries.length > 0) {
          seekIndex = msg.entries.findIndex((e) => e.relTime >= seekTime);
          if(seekIndex === -1) {
              seekIndex = 0;
          }

          seekTime = msg.entries[seekIndex].relTime;
      }

      this.setState({seekTime, seekIndex, selectedMessage: msgKey});
    }

    updateSelectedMessages(selectedMessages) {
        this.setState({selectedMessages});
    }

    onMessageUnselected(msgKey) {
      this.setState({selectedMessage: null});
    }

    loginWithGithub() {
        return (
            <a href={GithubAuth.authorizeUrl(this.state.route.fullname || '')}
                className='button button--dark button--inline'>
                <i className='fa fa-github'></i>
                <span> Log in with Github</span>
            </a>
        )
    }

    render() {
        return (
            <div id='cabana' className={ cx({ 'is-showing-modal': this.showingModal() }) }>
                {this.state.isLoading ?
                    <LoadingBar
                      isLoading={this.state.isLoading}
                    /> : null}
                <div className='cabana-header'>
                    <a className='cabana-header-logo' href=''>Comma Cabana</a>
                    <div className='cabana-header-account'>
                        {this.props.githubAuthToken  ?
                            <p>GitHub Authenticated</p>
                            : this.loginWithGithub()
                        }
                    </div>
                </div>
                <div className='cabana-window'>
                    <Meta url={this.state.route.url}
                          messages={this.state.messages}
                          selectedMessages={this.state.selectedMessages}
                          updateSelectedMessages={this.updateSelectedMessages}
                          showEditMessageModal={this.showEditMessageModal}
                          currentParts={this.state.currentParts}
                          onMessageSelected={this.onMessageSelected}
                          onMessageUnselected={this.onMessageUnselected}
                          showLoadDbc={this.showLoadDbc}
                          showSaveDbc={this.showSaveDbc}
                          dbcFilename={this.state.dbcFilename}
                          dbcLastSaved={this.state.dbcLastSaved}
                          dongleId={this.props.dongleId}
                          name={this.props.name}
                          route={this.state.route}
                          seekTime={this.state.seekTime}
                          maxByteStateChangeCount={this.state.maxByteStateChangeCount}
                          isDemo={this.props.isDemo}
                  />
                  {this.state.route.url ?
                      <Explorer
                          url={this.state.route.url}
                          messages={this.state.messages}
                          selectedMessage={this.state.selectedMessage}
                          onConfirmedSignalChange={this.onConfirmedSignalChange}
                          onSeek={this.onSeek}
                          onUserSeek={this.onUserSeek}
                          canFrameOffset={this.state.canFrameOffset}
                          firstCanTime={this.state.firstCanTime}
                          seekTime={this.state.seekTime}
                          seekIndex={this.state.seekIndex}
                          currentParts={this.state.currentParts}
                          partsLoaded={this.state.partsLoaded}
                          autoplay={this.props.autoplay}
                          showEditMessageModal={this.showEditMessageModal}
                          onPartChange={this.onPartChange}
                          route={this.state.route}
                          partsCount={this.state.route.proclog || 0}
                           />
                          : null}
                </div>

                {this.state.showLoadDbc ?
                    <LoadDbcModal
                        onDbcSelected={this.onDbcSelected}
                        handleClose={this.hideLoadDbc}
                        openDbcClient={this.openDbcClient}
                        loginWithGithub={this.loginWithGithub()}
                        /> : null}

                {this.state.showSaveDbc ?
                    <SaveDbcModal
                        dbc={this.state.dbc}
                        sourceDbcFilename={this.state.dbcFilename}
                        onDbcSaved={this.onDbcSaved}
                        handleClose={this.hideSaveDbc}
                        openDbcClient={this.openDbcClient}
                        hasGithubAuth={this.props.githubAuthToken !== null}
                        loginWithGithub={this.loginWithGithub()}
                        /> : null}

                {this.state.showEditMessageModal ?
                    <EditMessageModal
                        handleClose={this.hideEditMessageModal}
                        handleSave={this.onMessageFrameEdited}
                        message={this.state.messages[this.state.editMessageModalMessage]}
                        /> : null}
            </div>
        );
    }
}
