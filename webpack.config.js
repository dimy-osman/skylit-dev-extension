//@ts-check

'use strict';

const path = require('path');

/**@type {import('webpack').Configuration}*/
const config = {
  target: 'node', // vscode extensions run in a Node.js-context
  mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: './src/extension.ts', // the entry point of this extension
  output: {
    // the bundle is stored in the 'dist' folder (check package.json)
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]'
  },
  devtool: 'source-map',
  externals: {
    vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded
    // Handle optional/platform-specific dependencies gracefully
    fsevents: "require('fsevents')" // Mac-specific, optional dependency
  },
  resolve: {
    // support reading TypeScript and JavaScript files
    extensions: ['.ts', '.js'],
    // Prefer browser/universal versions of modules when available
    mainFields: ['module', 'main']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  // Ignore warnings for optional dependencies
  ignoreWarnings: [
    {
      module: /node_modules\/chokidar/,
      message: /Can't resolve 'fsevents'/
    }
  ],
  // Ensure Node.js polyfills are not included (we're in Node.js context)
  node: false
};
module.exports = config;
