const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');
const dotenv = require('dotenv');

const env = dotenv.config({ path: path.resolve(__dirname, '.env.local') }).parsed || {};

const DEFAULT_DEV_API = 'http://127.0.0.1:3000';

const API_BASE_URL = env.API_BASE_URL || process.env.API_BASE_URL || DEFAULT_DEV_API;

module.exports = {
  entry: './src/index.jsx',
  output: {
    filename: 'bundle.[contenthash].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
        },
      },
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader'],
      },
      {
        test: /\.svg$/i,
        issuer: /\.[jt]sx?$/,
        use: ['@svgr/webpack'],
      },
      {
        test: /\.svg$/i,
        type: 'asset/resource',
        issuer: { not: [/\.[jt]sx?$/] },
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, 'src/index.html'),
      favicon: false,
    }),
    new webpack.DefinePlugin({
      'process.env.API_BASE_URL': JSON.stringify(API_BASE_URL),
    }),
  ],
  devServer: {
    static: {
      directory: path.join(__dirname, 'public'),
    },
    compress: true,
    port: 5173,
    historyApiFallback: true,
    open: true,
  },
  devtool: 'source-map',
  resolve: {
    extensions: ['.js', '.jsx'],
  },
};
