import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";
import { readPref } from "../lib/prefs";

// Read at module init, which is why `hydratePrefs()` has to have finished
// before this module is imported (see main.tsx) — i18next takes its language
// once, and a late correction shows the author a flash of the wrong one.
const savedLang = readPref("app:language") || "zh-CN";

i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    en: { translation: en },
  },
  lng: savedLang,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
