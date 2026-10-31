// Builds the Android project from the web app in ../docs/app. Run by the "Build Android app" workflow
// (and works on your own computer too):  npm ci && node scripts/prepare-android.mjs && npx cap sync android
// Safe to run repeatedly. Nothing under mobile/android is hand-edited; this script applies every change.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const sh = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });
const read = (p) => fs.readFileSync(p, "utf8");
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const BRAND = "#4F3FF0";

// 1. Web files -> www (the service worker is for browsers only; the app bundles its own files).
const www = path.join(root, "www");
fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(path.join(root, "..", "docs", "app"), www, { recursive: true });
fs.rmSync(path.join(www, "sw.js"), { force: true });
console.log("web files copied to mobile/www");

// 2. Android project (created once; ignored by git, so every CI run starts clean).
const android = path.join(root, "android");
if (!fs.existsSync(android)) sh("npx cap add android");
const app = path.join(android, "app");
const res = path.join(app, "src", "main", "res");

// 3. Icons: launcher + adaptive foreground at every density, brand-colour background.
fs.cpSync(path.join(root, "resources", "android"), res, { recursive: true });
write(path.join(res, "values", "ic_launcher_background.xml"),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BRAND}</color>\n</resources>\n`);

// 4. Splash: brand colour with the logo in the middle, instead of the stock Capacitor image.
for (const d of fs.readdirSync(res)) {
  if (!/^drawable/.test(d)) continue;
  const f = path.join(res, d, "splash.png");
  if (fs.existsSync(f)) fs.rmSync(f);
}
write(path.join(res, "drawable", "splash.xml"),
`<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item><shape android:shape="rectangle"><solid android:color="${BRAND}"/></shape></item>
    <item android:gravity="center" android:width="220dp" android:height="220dp">
        <bitmap android:src="@mipmap/ic_launcher_foreground" android:gravity="fill"/>
    </item>
</layer-list>
`);
const stylesFile = path.join(res, "values", "styles.xml");
let styles = read(stylesFile);
styles = styles.replace(/<style name="AppTheme.NoActionBarLaunch"[\s\S]*?<\/style>/,
`<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/splash</item>
        <item name="windowSplashScreenBackground">${BRAND}</item>
        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
    </style>`);
write(stylesFile, styles);

// 5. Manifest: portrait only, no cloud auto-backup of the sign-in state.
const manifestFile = path.join(app, "src", "main", "AndroidManifest.xml");
let man = read(manifestFile);
if (!man.includes("screenOrientation")) man = man.replace('android:launchMode="singleTask"', 'android:launchMode="singleTask"\n            android:screenOrientation="portrait"');
man = man.replace('android:allowBackup="true"', 'android:allowBackup="false"');
write(manifestFile, man);

// 6. Signing + version. The key in mobile/keystore is fixed, so every new build installs as an UPDATE over the old one.
const gradleFile = path.join(app, "build.gradle");
let g = read(gradleFile);
if (!g.includes("signingConfigs")) {
  g = g.replace(/versionCode \d+/, `versionCode ${process.env.VERSION_CODE || 1}`)
       .replace(/versionName "[^"]*"/, `versionName "${process.env.VERSION_NAME || "1.0"}"`)
       .replace("buildTypes {", `signingConfigs {
        release {
            storeFile file("../../keystore/breakout.jks")
            storePassword "breakoutdesk"
            keyAlias "breakout"
            keyPassword "breakoutdesk"
        }
    }
    buildTypes {`)
       .replace("release {\n            minifyEnabled false", "release {\n            signingConfig signingConfigs.release\n            minifyEnabled false");
  write(gradleFile, g);
}
console.log("Android project prepared.");
