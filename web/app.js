// foolflix - vanilla JS hello-world interaction
(function () {
  "use strict";

  const shows = [
    { title: "Hello, World", genre: "Classic", year: 1974, icon: "\u{1F44B}", hue: "#e50914",
      line: "Hello, world! The fool-oracle says hi." },
    { title: "The Awakening", genre: "Drama", year: 2024, icon: "\u{1F331}", hue: "#2d6a4f",
      line: "Every oracle begins with a single hello." },
    { title: "Pattern Recognition", genre: "Docuseries", year: 2025, icon: "\u{1F52E}", hue: "#4361ee",
      line: "Patterns over intentions. Nothing deleted." },
    { title: "Recursive Greetings", genre: "Sci-Fi", year: 2026, icon: "\u{1F300}", hue: "#8338ec",
      line: "Hello, hello, hello... it is hellos all the way down." },
    { title: "Ship It", genre: "Comedy", year: 2025, icon: "\u{1F680}", hue: "#f77f00",
      line: "It compiles. Ship it." },
    { title: "404: Fear Not Found", genre: "Thriller", year: 2023, icon: "\u{1F577}\uFE0F", hue: "#3a0ca3",
      line: "The only thing to fear is an unhandled promise rejection." }
  ];

  const heroGreeting = document.getElementById("hero-greeting");
  const cardRow = document.getElementById("card-row");

  function announce(text, sourceCard) {
    heroGreeting.textContent = text;
    heroGreeting.hidden = false;
    cardRow.querySelectorAll(".card.speaking").forEach(function (el) {
      el.classList.remove("speaking");
    });
    if (sourceCard) {
      sourceCard.classList.add("speaking");
    }
  }

  function makeCard(show) {
    const card = document.createElement("li");
    card.className = "card";
    card.tabIndex = 0;
    card.style.setProperty("--card-hue", show.hue);
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", show.title + " - " + show.genre + " - press to play greeting");

    const poster = document.createElement("div");
    poster.className = "card-poster";
    poster.setAttribute("aria-hidden", "true");
    poster.textContent = show.icon;

    const title = document.createElement("h3");
    title.className = "card-title";
    title.textContent = show.title;

    const meta = document.createElement("p");
    meta.className = "card-meta";
    meta.textContent = show.year + " \u00B7 " + show.genre;

    card.append(poster, title, meta);

    card.addEventListener("click", function () {
      announce(show.line, card);
    });
    card.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        announce(show.line, card);
      }
    });

    return card;
  }

  const fragment = document.createDocumentFragment();
  shows.forEach(function (show) {
    fragment.appendChild(makeCard(show));
  });
  cardRow.appendChild(fragment);

  document.getElementById("play-btn").addEventListener("click", function () {
    const pick = shows[Math.floor(Math.random() * shows.length)];
    announce(pick.line, null);
  });
})();
