# SafeSightAI+ Prototype

Construction site safety AI prototype — Frontend + Text Engine + YOLO Vision Engine.

## Live Demo

Pick ONE of the two options below. Both give you a permanent link that
auto-updates every time you push new files — you never change the link
in your PPT again.

### Option A — GitHub Pages (simplest, no extra sign-up)

1. Create a new GitHub repo and upload everything in this folder
   (`index.html`, `README.md`, `.gitignore`, `/prototype`, `/engine`,
   `/yolo`) directly into the repo **root** — not inside a subfolder.
2. Go to the repo's **Settings → Pages**.
3. Under "Build and deployment", set Source = "Deploy from a branch",
   Branch = `main`, folder = `/ (root)`. Save.
4. Wait ~1 minute. Your link will be:
   `https://<your-username>.github.io/<repo-name>/`
5. Every time you `git push` again later (e.g. after training the YOLO
   model), this same link updates automatically within a minute or two.

### Option B — Vercel

1. Push this folder's contents to a GitHub repo (same as step 1 above).
2. Go to vercel.com → "Add New Project" → import that repo → Deploy.
3. Your permanent link will be:

`https://your-project-name.vercel.app`

4. Every future push to the repo redeploys automatically.

### What is included

| Folder / File      | Description                                      | Status                  |
|--------------------|--------------------------------------------------|-------------------------|
| `/` (this page)    | Main landing page with links to everything       | Ready                   |
| `/prototype`       | Full frontend UI prototype                       | Ready (browser demo)    |
| `/engine`          | Working text-based hazard classifier + tickets   | Fully working           |
| `/yolo`            | YOLO vision detection engine (Python)            | Runs locally only       |

## How to update later

1. Train your custom YOLO model.
2. Replace `yolo/yolov8n.pt` with your new trained file (e.g. `safesight_trained.pt`).
3. Update the `MODEL_PATH` line inside `yolo/main.py` if the filename changed.
4. Commit the changes on GitHub.
5. The live link updates automatically within 1–2 minutes.

## YOLO Engine Notes

- The current model (`yolov8n.pt`) is the **stock** YOLOv8n model.
- It only detects everyday objects (person, car, etc.).
- It does **not** yet detect construction-specific hazards (no helmet, no vest, etc.).
- After you train a proper PPE model, just upload the new `.pt` file — the rest of the code is already prepared for it.

See `yolo/SETUP_WINDOWS.txt` for how to run the vision engine on your computer.

## Do not upload

- `venv/` folder
- `__pycache__/` folder
- Any large temporary files

These are already ignored by `.gitignore`.
