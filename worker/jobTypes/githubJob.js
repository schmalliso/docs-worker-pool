const fs = require('fs-extra');
const workerUtils = require('../utils/utils');
const simpleGit = require('simple-git/promise');
const request = require('request');
const utils = require('../utils/utils');
const { getRepoBranches } = require('../utils/utils');


class GitHubJobClass {
    // pass in a job payload to setup class
    constructor(currentJob) {
        this.currentJob = currentJob;
    }

    // get base path for public/private repos
    getBasePath() {
        const currentJob = this.currentJob;
        var basePath = (currentJob.payload.private) ? `https://${process.env.GITHUB_BOT_USERNAME}:${process.env.GITHUB_BOT_PASSWORD}@github.com`:"https://github.com";
        return basePath;
    }

    getRepoDirName() {
        return `${this.currentJob.payload.repoName}`;
    }

    buildNextGen() {
        const workerPath = `repos/${this.getRepoDirName()}/worker.sh`;
        if (fs.existsSync(workerPath)) {
            // the way we now build is to search for a specific function string in worker.sh
            // which then maps to a specific target that we run
            const workerContents = fs.readFileSync(workerPath, {
                encoding: 'utf8'
            });
            const workerLines = workerContents.split(/\r?\n/);

            // check if need to build next-gen instead
            for (let i = 0; i < workerLines.length; i++) {
                if (workerLines[i] === '"build-and-stage-next-gen"') {
                    return true;
                }
            }
        }
        return false;
    }
    async constructManifestIndexPath(logger){
        try {
            const snootyName = await utils.getSnootyProjectName(this.getRepoDirName());
            this.currentJob.payload.manifestPrefix = snootyName + '-' + (this.currentJob.payload.alias ? this.currentJob.payload.alias : this.currentJob.payload.branchName)
        } catch (error) {
            logger.save(error)
            throw error
        }
        
    }
    async constructPrefix(isProdDeployJob){    
      try{
        // check the repo's entry in the db to see if it is versioned

        const branchInfo = getRepoBranches(this.currentJob.payload.repoName)
        const versioned = branchInfo["versioned"]
        const prefix = branchInfo["repo_branches"]["prefix"]
        const server_user = await workerUtils.getServerUser()
        
        let pathPrefix;
        
        // prefix is constructed by front-end for staging jobs -- construct prefix for deploy jobs now
        if(isProdDeployJob){
          //versioned repo
          if(versioned){
            pathPrefix = `${prefix}/${ this.currentJob.payload.alias ? this.currentJob.payload.alias : this.currentJob.payload.branchName}`; 
          }
          //non versioned repo
          else{
            pathPrefix = `${prefix}`;
          }
        }
        //mut only expects prefix or prefix/version for versioned repos, have to remove server user from staging prefix
        if(typeof pathPrefix !== 'undefined' && pathPrefix !== null){
          this.currentJob.payload.pathPrefix = pathPrefix;
          const mutPrefix = pathPrefix.split(`/${server_user}`)[0];
          this.currentJob.payload.mutPrefix = mutPrefix;
        }
      }catch(error){
        console.log(error)
        throw error
      }
        
    }

    async applyPatch(patch, currentJobDir) {
        //create patch file
        try {
          fs.writeFileSync(`repos/${currentJobDir}/myPatch.patch`, patch, { encoding: 'utf8', flag: 'w' });
          
        } catch (error) {
            console.log('Error creating patch ', error);
            throw error;
        }
        //apply patch
        try {
          const commandsToBuild = [
            `cd repos/${currentJobDir}`,
            `patch -p1 < myPatch.patch`
          ];
            const exec = workerUtils.getExecPromise();
            await exec(commandsToBuild.join('&&'));   
          
        } catch (error) {
            console.log('Error applying patch: ', error)
            throw error;
        }
    }

    dumpError(err) {
        if (typeof err === 'object') {
          if (err.message) {
            console.log('\nMessage: ' + err.message)
          }
          if (err.stack) {
            console.log('\nStacktrace:')
            console.log('====================')
            console.log(err.stack);
          }
        } else {
          console.log('dumpError :: argument is not an object');
        }
    }

    // our maintained directory of makefiles
    async downloadMakefile() {
        const makefileLocation = `https://raw.githubusercontent.com/mongodb/docs-worker-pool/meta/makefiles/Makefile.${this.currentJob.payload.repoName}`;
        const returnObject = {};
        return new Promise(function(resolve, reject) {
            request(makefileLocation, function(error, response, body) {
                if (!error && body && response.statusCode === 200) {
                    returnObject['status'] = 'success';
                    returnObject['content'] = body;
                } else {
                    returnObject['status'] = 'failure';
                    returnObject['content'] = response;
                }
                resolve(returnObject);
                reject(error);
            });
        });
    }

    // cleanup before pulling repo
    async cleanup(logger) {
        logger.save(`${'(rm)'.padEnd(15)}Cleaning up repository`);
        try {
            workerUtils.removeDirectory(`repos/${this.getRepoDirName()}`);
        } catch (errResult) {
            logger.save(`${'(CLEANUP)'.padEnd(15)}failed cleaning repo directory`);
            throw errResult;
        }
        return new Promise(function(resolve, reject) {
            logger.save(`${'(rm)'.padEnd(15)}Finished cleaning repo`);
            resolve(true);
            reject(false);
        });
    }

    async cloneRepo(logger) {
        const currentJob = this.currentJob;
        logger.save(`${'(GIT)'.padEnd(15)}Cloning repository`);
        logger.save(`${'(GIT)'.padEnd(15)}running fetch`);
        try {
            if (!currentJob.payload.branchName) {
                logger.save(
                    `${'(CLONE)'.padEnd(15)}failed due to insufficient definition`
                );
                throw new Error('branch name not indicated');
            }
            const basePath = this.getBasePath();
            const repoPath =
                basePath +
                '/' +
                currentJob.payload.repoOwner +
                '/' +
                currentJob.payload.repoName;
            await simpleGit('repos')
                .silent(false)
                .clone(repoPath, `${this.getRepoDirName()}`)
                .catch(err => {
                    console.error('failed: ', err);
                    throw err;
                });
        } catch (errResult) {
            logger.save(`${'(GIT)'.padEnd(15)}stdErr: ${errResult.stderr}`);
            throw errResult;
        }
        return new Promise(function(resolve, reject) {
            logger.save(`${'(GIT)'.padEnd(15)}Finished git clone`);
            resolve(true);
            reject(false);
        });
    }

    async buildRepo(logger, gatsbyAdapter, isProdDeployJob) {
        const currentJob = this.currentJob;

        // setup for building
        await this.cleanup(logger);
        await this.cloneRepo(logger);

        logger.save(`${'(BUILD)'.padEnd(15)}Running Build`);
        logger.save(`${'(BUILD)'.padEnd(15)}running worker.sh`);

        const exec = workerUtils.getExecPromise();
        const pullRepoCommands = [`cd repos/${this.getRepoDirName()}`];

        // if commit hash is provided, use that
        if (currentJob.payload.newHead && currentJob.title !== 'Regression Test Child Process') {
            const commitCheckCommands = [
                `cd repos/${this.getRepoDirName()}`,
                `git fetch`,
                `git checkout ${currentJob.payload.branchName}`,
                `git branch ${currentJob.payload.branchName} --contains ${currentJob.payload.newHead}`
            ];

            try {
                const {
                    stdout
                } = await exec(commitCheckCommands.join('&&'));

                if (!stdout.includes(`* ${currentJob.payload.branchName}`)) {
                    const err = new Error(
                        `Specified commit does not exist on ${currentJob.payload.branchName} branch`
                    );
                    logger.save(
                        `${'(BUILD)'.padEnd(
              15
            )} failed. The specified commit does not exist on ${
              currentJob.payload.branchName
            } branch.`
                    );
                    return new Promise(function(resolve, reject) {
                        reject(err);
                    });
                }
            } catch (error) {
                logger.save(
                    `${'(BUILD)'.padEnd(15)}failed with code: ${error.code}. `
                );
                logger.save(`${'(BUILD)'.padEnd(15)}stdErr: ${error.stderr}`);
                throw error;
            }

            pullRepoCommands.push(
                ...[
                    `git checkout ${currentJob.payload.branchName}`,
                    `git pull origin ${currentJob.payload.branchName}`,
                    `git checkout ${currentJob.payload.newHead} .`
                ]
            );

        } else {
            pullRepoCommands.push(
                ...[
                    `git checkout ${currentJob.payload.branchName}`,
                    `git pull origin ${currentJob.payload.branchName}`
                ]
            );
        }

        try {
        
            await exec(pullRepoCommands.join(' && '));

        } catch (error) {
            logger.save(
                `${'(BUILD)'.padEnd(15)}failed with code: ${error.code}`
            );
            logger.save(`${'(BUILD)'.padEnd(15)}stdErr: ${error.stderr}`);

            throw error;
        }

       //check for patch
      if (currentJob.payload.patch !== undefined) {
        await this.applyPatch(
          currentJob.payload.patch,
          this.getRepoDirName(currentJob)
        );
      }

        // overwrite repo makefile with the one our team maintains
        const makefileContents = await this.downloadMakefile();
        if (makefileContents && makefileContents.status === 'success') {
            await fs.writeFileSync(
                `repos/${this.getRepoDirName()}/Makefile`,
                makefileContents.content, {
                    encoding: 'utf8',
                    flag: 'w'
                }
            );
        } else {
            console.log(
                'ERROR: makefile does not exist in /makefiles directory on meta branch.'
            );
        }
        
        // default commands to run to build repo
        const commandsToBuild = [
          `. /venv/bin/activate`,
          `cd repos/${this.getRepoDirName()}`,
          `rm -f makefile`,
          `make html`
      ];
      
      // server specifies path prefix for stagel commit jobs and prod deploy jobs only, which we
      // save to job object to pass to mut in S3Publish.js. 
        
      // Front end constructs path for regular staging jobs 
      // via the env vars defined/written in GatsbyAdapter.initEnv(), so the server doesn't have to create one here
      // check if need to build next-gen
      if(this.buildNextGen()){
        await this.constructPrefix(isProdDeployJob);
        await gatsbyAdapter.initEnv();
      }

      if (this.buildNextGen() && !isProdDeployJob) {
        commandsToBuild[commandsToBuild.length - 1] = 'make next-gen-html';
        //tell Gatsby to pull in draft data from CMS
        //TODO: this stanza can be removed when devhub is entirely off autobuilder
        if (this.currentJob.payload.repoName === 'devhub-content-integration') {
            commandsToBuild[commandsToBuild.length - 1] += ` STRAPI_PUBLICATION_STATE=preview`;
          }
      }

      //check if prod deploy job
      if (this.buildNextGen() && isProdDeployJob) {
        // we only generate a single search index per branch to ensure we do not have duplicate search indexes
        // duplicate indexes === only differ by the suffix of the url, /atlas vs /saas vs /master
        // if a branch is not aliased (and therefore not duplicated) or if this is the primary alias of a branch, construct a path for search index
        if( ! this.currentJob.payload.aliased || ( this.currentJob.payload.aliased && this.currentJob.payload.primaryAlias ) ) {
            await this.constructManifestIndexPath(logger); 
        }
        commandsToBuild[commandsToBuild.length - 1] = 'make get-build-dependencies';
        commandsToBuild.push('make next-gen-html')
          
      }

        const execTwo = workerUtils.getExecPromise();
        try {
            const {
                stdout,
                stderr
            } = await execTwo(commandsToBuild.join(' && '));

            return new Promise(function(resolve, reject) {
                logger.save(`${'(BUILD)'.padEnd(15)}Finished Build`);
                logger.save(
                    `${'(BUILD)'.padEnd(
                15
              )}worker.sh run details:\n\n${stdout}\n---\n${stderr}`
                );
                resolve({
                    status: 'success',
                    stdout: stdout,
                    stderr: stderr
                });
                reject({
                    status: 'success',
                    stderr: stderr
                });
            });
        } catch (error) {
          logger.save(
            `${'(BUILD)'.padEnd(15)}failed with code: ${error.code}`
          );
          logger.save(`${'(BUILD)'.padEnd(15)}stdErr: ${error.stderr}`);
          logger.save(`${'(BUILD)'.padEnd(15)}stdout: ${error.stdout}`);
          throw error;              
        }

    }
}

module.exports = {
    GitHubJobClass: GitHubJobClass
};
