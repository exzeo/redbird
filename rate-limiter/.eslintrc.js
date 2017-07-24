module.exports = {
  "env": {
    "es6": true,
    "node": true
  },
  "parserOptions": {
    "ecmaVersion": 2017
  },
  "extends": "airbnb-base",
  "rules": {
    "comma-dangle": [2, "never"],
    "consistent-return": [0],
    "arrow-body-style": [1, "as-needed"],
    "import/no-unresolved": [0],
    "strict": [0, "global"],
    "global-require": [0],
    "no-plusplus": [0],
    "no-restricted-syntax": [0]
  }
};
