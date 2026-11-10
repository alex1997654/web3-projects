# Portfolio site

Static, hand-written, no build step. Served by GitHub Pages straight from the main branch.

## Publish

1. Create a public repo named <username>.github.io under your GitHub account.
2. Copy these files into it, fill the three TODO placeholders in index.html (GitHub username, Upwork profile URL, email).
3. Push to main. The site goes live at https://<username>.github.io within a minute or two.
4. Settings > Pages should show "Deploy from a branch", branch main, folder / (root). Enforce HTTPS stays on.

## Editing

All content lives in index.html. Styling in styles.css. There is nothing else to know.

## Adding a project card when a project repo goes public

In the Example projects section, replace the bullet for that project with a card:

    <div class="card">
      <h3>Title</h3>
      <p>One short paragraph: what it is and the design decision worth reading.</p>
      <p class="muted">
        <a href="REPO_URL">repo</a> ·
        <a href="DEMO_URL">demo</a> ·
        devnet: <code>PROGRAM_ID</code> ·
        <img src="BADGE_URL" alt="CI">
      </p>
    </div>

The verify command goes in the repo README, not on the card: solana program show PROGRAM_ID --url devnet

Add this to styles.css when the first card lands:

    .card { border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.2rem; margin-bottom: 1.1rem; }
    .card h3 { margin: 0 0 0.5rem; font-size: 1.05rem; }

## Style rule for all copy on this site

Plain, direct, human. No em-dash-heavy sentences, no perfectly parallel bullet lists, no filler words (seamless, robust, delve, elevate, leverage as a verb). Vary sentence length. If a sentence sounds machine-generated, rewrite it.

## CI

A minimal workflow lints the HTML on every push. Keep it green. Badge is not needed on the site itself.
