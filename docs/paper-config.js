// Paper trading connection settings.
// Leave these empty to run in DEMO mode (data saved only in this browser, no login, orders never fill).
// To sync across devices, create a free Firebase project (see README, "Paper trading") and paste the
// values Firebase shows for your web app: Project settings -> General -> Your apps -> SDK setup and configuration.
// These values are meant to be public. Your data is protected by your login and the Firestore security rules.
// NEVER put a service-account key here.
window.PAPER_CONFIG = {
  firebase: {
    apiKey: "AIzaSyCK_QvjnnsMkPbMmsh3gCGEJMishLiBNe8",
    authDomain: "paper--trading.firebaseapp.com",
    projectId: "paper--trading",
    appId: "1:213439773379:web:3268c57e9910f52ad98076",
  },
};
