const path = require("path");
const TerserPlugin = require("terser-webpack-plugin");

module.exports = (_env, argv) => {
  const mode = argv && argv.mode ? argv.mode : "production";
  return {
    target: "node20",
    entry: "./src/plugin/index.ts",
    mode: mode,
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "index.js",
      library: { type: "commonjs2" },
      clean: true,
    },
    resolve: {
      extensions: [".ts", ".js"],
      alias: {
        [path.resolve(__dirname, "node_modules/grammy/out/shim.node.js")]:
          path.resolve(__dirname, "src/plugin/grammy-shim-node.js"),
      },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: "ts-loader",
          exclude: /node_modules/,
        },
      ],
    },
    externalsPresets: { node: true },
    externals: {
      express: "commonjs2 express",
      "socks-proxy-agent": "commonjs2 socks-proxy-agent",
      "http-proxy-agent": "commonjs2 http-proxy-agent",
      "https-proxy-agent": "commonjs2 https-proxy-agent",
    },
    optimization: {
      minimize: mode === "production",
      minimizer: [
        new TerserPlugin({
          extractComments: false,
          terserOptions: {
            keep_classnames: true,
            keep_fnames: true,
            format: { comments: false },
          },
        }),
      ],
    },
    performance: { hints: false },
    devtool: mode === "production" ? "source-map" : "inline-source-map",
  };
};
