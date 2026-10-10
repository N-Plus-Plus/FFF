window.FFF_CACHE_BUSTER = String(Date.now());
const style = document.createElement("link");
style.rel = "stylesheet";
style.href = `/style.css?v=${window.FFF_CACHE_BUSTER}`;
document.head.append(style);
import(`./app.js?v=${window.FFF_CACHE_BUSTER}`);
