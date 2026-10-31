/* Storage for the paper-trading records. Two back ends with the same methods:
   - cloud: Firebase (email + password sign-in, Firestore). Exactly the documents docs/paper.html and paper/engine.py use,
            so the website, the app and the daily order engine all see the same account.
   - demo:  records kept on this phone only (no sign-in, orders never fill). Used when Firebase is not configured. */
(function () {
  "use strict";
  const ls = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + Math.random().toString(16).slice(2));

  const FB_MSG = {
    "auth/invalid-credential": "Wrong email or password.", "auth/wrong-password": "Wrong email or password.", "auth/user-not-found": "Wrong email or password.",
    "auth/invalid-login-credentials": "Wrong email or password.", "auth/invalid-email": "That email address does not look right.",
    "auth/missing-email": "Type your email.", "auth/missing-password": "Type your password.",
    "auth/email-already-in-use": "That email already has an account. Use Sign in.", "auth/weak-password": "Choose a password of at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes, or use Forgot password.", "auth/user-disabled": "This account has been disabled.",
    "auth/admin-restricted-operation": "New accounts are switched off in this Firebase project. Use Sign in with the account you already made.",
    "auth/operation-not-allowed": "Email/password sign-in is not switched on in the Firebase console (Authentication → Sign-in method).",
    "auth/network-request-failed": "Could not reach Firebase. Check your internet connection and try again.",
    "auth/invalid-api-key": "The apiKey in config.js is not valid. Copy it again from the Firebase console.",
    "permission-denied": "Firebase refused the request. Publish the security rules from paper/firestore.rules (see the README), then reload.",
    "unavailable": "Could not reach Firebase. Check your internet connection and try again.",
    "not-found": "The Firestore database has not been created yet (Firebase console → Firestore Database → Create database).",
  };
  const errMsg = e => (e && FB_MSG[e.code]) || (e && e.message) || String(e);

  function loadScript(src) {
    return new Promise((ok, no) => {
      const s = document.createElement("script"); s.src = src; s.onload = ok;
      s.onerror = () => no(new Error("Could not load " + src)); document.head.appendChild(s);
    });
  }

  function localStore() {
    const KEY = "breakout-desk-demo-v1";
    const load = () => { try { return JSON.parse(ls.get(KEY)) || {}; } catch (e) { return {}; } };
    const save = d => ls.set(KEY, JSON.stringify(d));
    return {
      mode: "demo", candles: {},
      async list(t) { return (load()[t] || []).slice(); },
      async insert(t, row) { const d = load(); const r = { id: uuid(), created_at: new Date().toISOString(), ...row }; (d[t] = d[t] || []).push(r); save(d); return r; },
      async update(t, id, patch) { const d = load(); const r = (d[t] || []).find(x => x.id === id); if (r) Object.assign(r, patch); save(d); return r; },
      async remove(t, id) { const d = load(); d[t] = (d[t] || []).filter(x => x.id !== id); save(d); },
      async getSettings() { return load().settings || {}; },
      async saveSettings(v) { const d = load(); d.settings = v; save(d); },
      async wipe() { save({}); },
    };
  }

  async function firebaseStore(cfg) {
    for (const f of ["firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js"]) await loadScript("vendor/" + f);
    firebase.initializeApp(cfg);
    const auth = firebase.auth(), db = firebase.firestore();
    const restored = new Promise(res => { const off = auth.onAuthStateChanged(u => { off(); res(u); }); });
    const uid = () => { if (!auth.currentUser) throw new Error("You are signed out. Reopen the app and sign in."); return auth.currentUser.uid; };
    const col = t => db.collection("users").doc(uid()).collection(t);
    const clean = o => JSON.parse(JSON.stringify(o));      // Firestore rejects undefined values
    const withId = d => ({ id: d.id, ...d.data() });
    const store = {
      mode: "cloud", candles: {},
      restore: () => restored,
      email: () => (auth.currentUser ? auth.currentUser.email : ""),
      async signIn(e, p) { await auth.signInWithEmailAndPassword(e, p); },
      async signUp(e, p) { await auth.createUserWithEmailAndPassword(e, p); },
      async reset(e) { await auth.sendPasswordResetEmail(e); },
      async signOut() { await auth.signOut(); },
      onSignedOut(cb) { let had = false; auth.onAuthStateChanged(u => { if (u) had = true; else if (had) { had = false; cb(); } }); },
      async list(t) {
        const snap = await col(t).get();
        if (t !== "prices") return snap.docs.map(withId);
        const out = [];                                    // one document per ticker holds its dates and closes
        for (const d of snap.docs) {
          const x = d.data(), yf = x.yf || d.id;
          if (x.chart && x.chart.d) store.candles[yf] = x.chart;
          (x.dates || []).forEach((date, i) => out.push({ yf, date, close: x.closes[i] }));
        }
        return out;
      },
      async insert(t, row) { const r = clean({ created_at: new Date().toISOString(), ...row }); const ref = await col(t).add(r); return { id: ref.id, ...r }; },
      async update(t, id, patch) { const ref = col(t).doc(id); await ref.update(clean(patch)); return withId(await ref.get()); },
      async remove(t, id) { await col(t).doc(id).delete(); },
      async getSettings() { const d = await col("settings").doc("main").get(); return d.exists ? (d.data().data || {}) : {}; },
      async saveSettings(v) { await col("settings").doc("main").set({ data: clean(v), updated_at: new Date().toISOString() }); },
    };
    return store;
  }

  window.Store = { localStore, firebaseStore, errMsg };
})();
