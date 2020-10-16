#!/usr/bin/env node

const commander = require('commander');
const shell = require('shelljs');
const moment = require('moment');
const rimraf = require('rimraf');
const Gauge = require('gauge');
const { promisify } = require('util');
const { dirname, join } = require('path');
const { create, extract } = require('tar');
const { execSync } = require('child_process');
const { green, red, yellow } = require('chalk').default;
const { existsSync, readFileSync, lstatSync, mkdirSync, readdirSync } = require('fs');
const { resolvedPackages } = require('./lib/cache');
const { resolveDependencies, downloadPackages } = require('./lib/fetch-packages');
const { publishFolder, publishTarball } = require('./lib/npm-publish');
const { getNpmTopPackages } = require('./lib/npm-top');
const currPackageJson = require('./package');

const rimrafPromise = promisify(rimraf);


/**
* Version and description
*/
commander
    .version(currPackageJson.version, '-v, --version')
    .description('Fetch and publish npm packages for private npm registry');

/**
* Fetch command
*/
commander
    .command('fetch [packages...]')
    .description('Fetch packages tarball from npm registry')
    .alias('f')
    .option('-p, --package-json <packageJson>', 'The path to package.json file')
    .option('--top <top>', 'Fetch top packages from npm registry api. <max: 5250>', parseInt)
    .option('-d, --dest <dest>', 'Packages destination folder')
    .option('--no-tar', 'Whether to create tar file from all packages')
    .option('--no-cache', 'Whether to save download packages in cache')
    .option('--dev', 'Whether to resolved dev dependencies')
    .option('--peer', 'Whether to resolved peer dependencies')
    .option('--optional', 'Whether to resolved optional dependencies')
    .option('-r, --registry <registry>', 'The registry url', undefined, 'https://registry.npmjs.org/')
    .action(async (packages, command) => {
        try {
            const startTime = moment();
            const destFolder = command.dest ? command.dest : `packages_${startTime.format('MMDDYYYY.HHmmss')}`;
            let currStage = 1;
            const stages = command.top && !command.packageJson && !packages.length ? 3 : 2;
            let packagesObj;


            // Logger function for progress bar
            const gauge = new Gauge();
            const logger = (message, percent = 0) => {
                gauge.show(`[${currStage}/${stages}] ${message}`, percent);
            };

            if (command.packageJson) {
                let packageJsonPath = command.packageJson;
                if (lstatSync(packageJsonPath).isDirectory()) {
                    packageJsonPath = join(command.packageJson, 'package.json');
                }

                if (!existsSync(packageJsonPath)) {
                    throw new Error(`The path "${packageJsonPath}" not existed`);
                }

                // Read and parse package.json file
                const file = readFileSync(packageJsonPath, 'utf-8');
                packagesObj = JSON.parse(file);

                if (!packagesObj || !packagesObj.dependencies) {
                    throw new Error('The package.json not contains dependencies list');
                }
            } else if (packages.length) {
                packagesObj = {
                    dependencies: packages.reduce((dependencies, currPackage) => {
                        let name;
                        let version;
                        if (currPackage.startsWith('@')) {
                            [name, version] = currPackage.split('@').slice(1);
                            name = `@${name}`;
                        } else {
                            [name, version] = currPackage.split('@');
                        }
                        dependencies[name] = version || 'latest';
                        return dependencies;
                    }, {}),
                };
            } else if (command.top) {
                logger(`Fetch top ${command.top} npm packages...`);
                const topPackages = await getNpmTopPackages(command.top, { logger });
                packagesObj = {
                    dependencies: topPackages.reduce((dependencies, currPackage) => {
                        dependencies[currPackage.name] = currPackage.version;
                        return dependencies;
                    }, {}),
                };

                gauge.hide();
                shell.echo(green(`[${currStage}/${stages}] Fetch top ${topPackages.length} npm packages completed`));

                currStage++;
            }

            if (!packagesObj || !packagesObj.dependencies) {
                return shell.echo(yellow(`Required arguments is missing.
    Please run:
        ${green('// For packages list')}
        npo fetch package1 package2

        ${green('// For package.json file')}
        npm fetch -p ./package.json

        ${green('// To fetch top npm packages')}
        npm fetch --top 1000`));
            }

            // Create destination folder
            if (!existsSync(destFolder)) {
                mkdirSync(destFolder);
            }

            // Clean packages in memory cache
            resolvedPackages.clean();

            // Resolve dependencies tree
            logger('Resolving dependencies...');
            const dependencies = await resolveDependencies(packagesObj, {
                dev: command.dev,
                peer: command.peer,
                optional: command.optional,
                registry: command.registry,
                logger,
            });

            gauge.hide();
            shell.echo(green(`[${currStage}/${stages}] Resolving dependencies completed with ${dependencies.length} packages`));
            currStage++;

            logger('Fetching packages...');
            const result = await downloadPackages(dependencies, {
                useCache: command.cache,
                logger,
                destFolder,
                registry: command.registry,
            });

            const completedPackages = result.filter(inspection => inspection.isFulfilled());
            const inCachePackages = dependencies.length - result.length;
            const displayAmount = completedPackages.length === result.length ? result.length : `${completedPackages.length}/${result.length}`;

            gauge.disable();
            shell.echo(green(`[${currStage}/${stages}] Fetching packages completed with ${displayAmount} packages ${inCachePackages ? `(${inCachePackages} packages already in cache)` : ''}`));


            if (!result.length) {
                // Remove dest folder if is empty
                const files = readdirSync(destFolder);
                if (!files.length) {
                    await rimrafPromise(destFolder);
                }

                return shell.echo(yellow('No packages found to fetch. Add --no-cache flag to disable cache'));
            }

            if (command.tar) {
                // Create new tarball
                await create({ file: `${destFolder}.tar` }, [destFolder]);

                if (!command.dest) {
                    await rimrafPromise(destFolder);
                }
            }

            const endTime = moment();
            const duration = moment.duration(endTime.diff(startTime));

            const hours = duration.hours();
            const minutes = duration.minutes();
            const seconds = duration.seconds();
            const milliseconds = duration.milliseconds();
            shell.echo(green(`      Duration: ${hours < 10 ? `0${hours}` : hours}:${minutes < 10 ? `0${minutes}` : minutes}:${seconds < 10 ? `0${seconds}` : seconds}:${milliseconds}`));
            shell.echo(green(`      Destination folder: ${command.tar ? `${destFolder}.tar` : destFolder} `));
        } catch (error) {
            console.log(error && error.message ? red(error.message) : error);
        }
    });

/**
 * Publish command
 */
commander
    .command('publish <path>')
    .alias('p')
    .option('-r, --registry <registry>', 'The private registry url')
    .option('-s, --skip-login', 'Whether to skip npm login command', false)
    .option('-f, --force', 'Whether to publish with --force flag', false)
    .option('-c, --concurrent <concurrent>', 'How many packages to publish concurrently', parseInt, 20)
    .option('--del-package', 'After successful publication package deleting the package file (.tgz)', false)
    .description('Publish packages tarball to private npm registry')
    .action(async (path, command) => {
        try {
            if (!existsSync(path)) {
                throw new Error(`The path "${path}" not existed`);
            }

            if (!command.skipLogin) {
                shell.echo('npm login');
                execSync('npm login', { stdio: 'inherit' });
            }

            if (command.registry) {
                shell.exec(`npm set registry ${command.registry}`);
            }

            // Chack if path is a file or folder
            if (lstatSync(path).isFile()) {
                // In case of tar file extract the packages
                if (path.endsWith('.tar')) {
                    const folderPath = path.replace('.tar', '');
                    await extract({ file: path, cwd: dirname(path) });
                    shell.cd(folderPath);
                    await publishFolder('.', { force: command.force, concurrent: command.concurrent, delPackage: command.delPackage });

                    if (command.delPackage) {
                        const files = readdirSync(folderPath);
                        if (!files.length) {
                            shell.cd(`${folderPath}\\..`);
                            await rimrafPromise(folderPath);
                        }
                    }
                } else {
                    await publishTarball(path, { force: command.force, delPackage: command.delPackage });
                }
            } else {
                shell.cd(path);
                await publishFolder('.', { force: command.force, concurrent: command.concurrent, delPackage: command.delPackage });
            }
        } catch (error) {
            console.log(error && error.message ? red(error.message) : error);
        }
    });

commander.parse(process.argv);
