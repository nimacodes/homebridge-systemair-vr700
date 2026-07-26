'use strict';

const { SystemairPlatform, PLATFORM_NAME } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, SystemairPlatform);
};
