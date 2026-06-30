const express = require("express");
const path = require("path");

const app = express();
const PORT = 10028;

app.use(express.json());

// servir le fichier HTML
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// recevoir les données du formulaire
app.post("/send", (req, res) => {
    const { nom, prenom } = req.body;

    console.log("Reçu:", nom, prenom);

    res.json({
        status: "ok",
        nom,
        prenom
    });
});

app.listen(PORT, () => {
    console.log("Serveur lancé sur port " + PORT);
});
