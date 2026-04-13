'use strict';

const sessionWsClients = new Map();
let _browserCount = 0;

module.exports = {
  sessionWsClients,
  getBrowserCount() {
    return _browserCount;
  },
  incrementBrowserCount() {
    _browserCount += 1;
    return _browserCount;
  },
  decrementBrowserCount() {
    if (_browserCount > 0) _browserCount -= 1;
    return _browserCount;
  },
};
