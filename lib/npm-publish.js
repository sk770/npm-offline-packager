const shell = require('shelljs');
const rimraf = require('rimraf');
const { chunk } = require('lodash');
const { basename } = require('path');
const { promisify, isString } = require('util');
const { mkdir, readFile, writeFile, readdir } = require('fs');
const { green, red, gray } = require('chalk').default;
const { extract, create } = require('tar');

const readFilePromise = promisify(readFile);
const writeFilePromise = promisify(writeFile);
const mkdirPromise = promisify(mkdir);
const readdirPromise = promisify(readdir);

/**
 * Publish tarball package to npm private registry
 *
 * @param {string} filePath The package file path
 * @param {{ force: boolean, delPackage: boolean }} options The options
 *
 * @returns {Promise<string>} The stdout/stderr
 */
function publishTarball(filePath, options = { force: false, delPackage: false }) {
    const filename = basename(filePath);

    if (!filename.endsWith('.tgz')) {
        return Promise.reject(new Error(`The file "${filename}" are not with tgz extension`));
    }

    const isLatest = filename.includes('-latest.tgz');
    let clearName = filename.replace('-latest.tgz', '.tgz');

    if (clearName.startsWith('@')) {
        clearName = clearName.replace('-', '/');
    }

    const matchName = clearName.match(/(.*)-/);
    const matchVersion = clearName.match(/(\d.*).tgz/);

    const packageName = matchName.length > 0 ? matchName[1] : null;
    const packageVersion = matchVersion.length > 0 ? matchVersion[1] : null;

    const packageFullName = packageName && packageVersion ? `${packageName}@${packageVersion}` : clearName;

    let command = `npm publish "${filePath}"`;
    if (packageName && packageVersion && !isLatest) {
        command += ` --tag ${packageName}@${packageVersion}`;
    }

    if (options.force) {
        command += ' --force';
    }

    return shellExec(command)
        .then((stdout) => {
            if (options.delPackage) {
                shellExec(`del "${filePath}"`)
                    .then(() => shell.echo(`installed package:${green(packageFullName)}, deleted file:${gray(clearName)}`));
            } else {
                shell.echo(green(packageFullName));
            }
            return stdout;
        })
        .catch((stderr) => {
            if (isString(stderr) && stderr.includes('EPUBLISHCONFLICT')) {
                shell.echo(`${packageFullName} - already exists`);
                return Promise.resolve(`${packageFullName} - already exists`);
            }

            // In case of publishConfig.registry in package.json
            // override it and republish
            if (isString(stderr) && stderr.includes('EPERM: operation not permitted')) {
                return republish(filePath, command)
                    .then((stdout) => {
                        shell.echo(`${green(packageFullName)} - Override publishConfig.registry in package.json`);
                        return stdout;
                    }).catch((err) => {
                        if (isString(err) && err.includes('EPUBLISHCONFLICT')) {
                            shell.echo(`${packageFullName} - Already exists`);
                            return Promise.resolve(`${packageFullName} - Already exists`);
                        }
                    });
            }

            return Promise.reject(stderr);
        });
}

/**
 * Publish tarball packages from folder to npm private registry
 *
 * @param {string} folderPath The packages folder path
 * @param {{ force: boolean, concurrent: number, delPackage: boolean }} options The options
 *
 * @returns {Promise<any>} The stdout/stderr
 */
async function publishFolder(folderPath, options = { force: false, concurrent: 20, delPackage: false }) {
    const files = await readdirPromise(folderPath);
    const chunkFiles = chunk(files, options.concurrent);

    for (let index = 0; index < chunkFiles.length; index += 1) {
        const currentChunk = chunkFiles[index];

        const promises = currentChunk
            .map(fileName => publishTarball(fileName, { force: options.force, delPackage: options.delPackage })
                .catch(err => shell.echo(red(err))));

        await Promise.all(promises);
    }
}

/**
 * Extract tarball package to override publishConfig.registry in package.json
 * and republish it
 *
 * @param {string} filePath The tarball path
 * @param {string} command The original command
 */
async function republish(filePath, command) {
    const fileName = basename(filePath);
    const folderPath = filePath.replace('.tgz', '');
    const newFileName = fileName.replace('.tgz', '-temp.tgz');
    const newCommand = command.replace(filePath, newFileName);

    // Create directory to extract package
    await mkdirPromise(folderPath).catch(() => {});

    // Extract package
    await extract({ file: filePath, cwd: folderPath });

    // Override publishConfig.registry in package.json
    let packageJson = await readFilePromise(`${folderPath}/package/package.json`, { encoding: 'utf-8' });
    packageJson = packageJson.replace('"publishConfig"', '"publishConfigRemoved"');
    await writeFilePromise(`${folderPath}/package/package.json`, packageJson, { encoding: 'utf-8' });

    // Create new tarball
    await create({ file: newFileName, cwd: folderPath, gzip: true }, ['package']);

    // Run npm publish with new command
    return shellExec(newCommand)
        .then((stdout) => {
            rimraf(folderPath, () => { });
            rimraf(newFileName, () => { });

            return stdout;
        })
        .catch((stderr) => {
            rimraf(folderPath, () => { });

            return Promise.reject(stderr);
        });
}

/**
 * Exec shell command
 *
 * @param {string} command Shell command
 *
 * @returns {Promise<string>} The result stdout/sdterr
 */
function shellExec(command) {
    return new Promise((resolve, reject) => {
        shell.exec(command, { async: true, silent: true }, (err, stdout, sdterr) => {
            if (err) {
                return reject(sdterr);
            }

            resolve(stdout);
        });
    });
}

module.exports = {
    publishTarball,
    publishFolder,
};
