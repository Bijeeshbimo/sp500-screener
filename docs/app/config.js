// Breakout Desk settings.
//
// pagesUrl: where your GitHub Pages site lives. The Android app downloads the daily screener results from here.
//           (The browser/PWA version at <pagesUrl>app/ reads them from the folder above itself and ignores this.)
//           You can also change it inside the app: More -> Settings -> Data source.
window.APP_CONFIG = {
  pagesUrl: "https://bijeeshbimo.github.io/sp500-screener/",
};

// Same Firebase web-app values as docs/paper-config.js. They are meant to be public;
// your data is protected by your login and the Firestore rules (paper/firestore.rules).
// Leave apiKey empty to run in DEMO mode (data stays on the phone, orders never fill).
window.PAPER_CONFIG = {
  firebase: {
    apiKey: "AIzaSyCK_QvjnnsMkPbMmsh3gCGEJMishLiBNe8",
    authDomain: "paper--trading.firebaseapp.com",
    projectId: "paper--trading",
    appId: "1:213439773379:web:3268c57e9910f52ad98076",
  },
};
