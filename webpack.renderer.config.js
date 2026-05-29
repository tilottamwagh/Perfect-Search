const rules = require('./webpack.rules');

rules.push({
  test: /\.css$/,
  use: ['style-loader', 'css-loader', 'postcss-loader'],
});

rules.push({
  test: /\.jsx?$/,
  exclude: /node_modules/,
  use: { loader: 'babel-loader' },
});

module.exports = {
  module: {
    rules,
  },
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.css'],
  },
};
