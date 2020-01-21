const fs = require('fs-extra');
const workerUtils = require('../utils/utils');
const simpleGit = require('simple-git/promise');
const request = require('request');

class RegressionTestJobClass {
  // pass in a job payload to setup class
  constructor(currentJob) {
    this.currentJob = currentJob;
  }
}

  module.exports = {
    RegressionTestJobClass: RegressionTestJobClass
  };