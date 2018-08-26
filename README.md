# npm-offline-packager

A CLI tool to download and publish NPM packages tarboll (with all dependencies) <br>
for offline npm registry ([verdaccio](https://github.com/verdaccio/verdaccio), artifactory, etc.) 

## Install

```
$ npm install -g npm-offline-packager
```

## Usage


### npo fetch - Fetch packages tarball from npm registry

```bash
 $ npo fetch <list of packages or a path to package-json file>
```

```
  Options:

    -p, --package-json <packageJson>  The path to package.json file
    --top <top>                       Fetch top packages from npm registry api. <max: 5250>
    -d, --dest <dest>                 Packages destination folder
    --no-tar                          Whether to create tar file from all packages
    --no-cache                        Whether to save download packages in cache
    --dev                             Whether to resolved dev dependencies
    --peer                            Whether to resolved peer dependencies
    --optional                        Whether to resolved optional dependencies
    -h, --help                        output usage information
```

#### Examples

To fetch a list of packages
```bash
 $ npo fetch express @types/express bluebird
```

To fetch top 1000 packages from npm registry api
```bash
 $ npo fetch --top 1000
```

To fetch dependencies from package.json file
```bash
 $ npo fetch ./package.json
```

### npo publish - Publish packages tarball to private npm registry

```bash
$  npo publish <path to tarball file or folder>
```

```
  Options:

    -r, --registry <registry>      The private registry url
    -s, --skip-login               Whether to skip npm login command
    -f, --force                    Whether to publish with --force flag
    -c, --concurrent <concurrent>  How many packages to publish concurrently (default: 20)
    -h, --help                     output usage information
```

## Authors

* [sk770](https://github.com/sk770)

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details