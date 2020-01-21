//const fs = require('fs-extra');
const workerUtils = require('../utils/utils');
const GitHubJob = require('../jobTypes/githubJob').GitHubJobClass;
const S3Publish = require('../jobTypes/S3Publish').S3PublishClass;
const validator = require('validator');
const Logger = require('../utils/logger').LoggerClass;

const buildTimeout = 60 * 450;

const invalidJobDef = new Error('job not valid');


