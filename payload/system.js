const key = "my_secret_key";



function xorDecode(encoded, key) {
    const text = atob(encoded);

    let result = "";

    for (let i = 0; i < text.length; i++) {
        result += String.fromCharCode(
            text.charCodeAt(i) ^
            key.charCodeAt(i % key.length)
        );
    }

    return result;
}

function getListener(origin) {
    async function ping() {
        try {
            const response = await fetch(origin, {
                method: "GET",
                credentials: "include"
            });

            console.log(
                `[${new Date().toISOString()}] Status:`,
                response.status
            );
        } catch (err) {
            console.error("Failed to reach origin:", err);
        }
    }

    ping();
    return setInterval(ping, 60 * 1000);
}

const timer = getListener("https://example.com/api/ping");