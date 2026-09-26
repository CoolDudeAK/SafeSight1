"""
================================================================================
 SafeSightAI+ — YOLO Detection Engine (main.py)
================================================================================
WHAT THIS FILE DOES
--------------------
This is a small web server (built with FastAPI) that:
  1. Waits for someone to upload a photo to the /detect endpoint
  2. Runs a YOLOv8 object-detection model on that photo
  3. Draws boxes around whatever it found
  4. Converts what it found into "hazards" (helmet missing, etc.) with a
     severity tier (Fatal / Dangerous / High / Medium / Low)
  5. Sends all of that back as JSON

IMPORTANT — PLEASE READ BEFORE YOU DEMO THIS
----------------------------------------------
The MODEL_PATH below defaults to "yolov8n.pt" — this is the STOCK YOLOv8n
model. It only knows 80 everyday objects (person, car, backpack, chair...).
It has NEVER been trained on "no helmet" or "exposed rebar" — those classes
simply don't exist in it. So out of the box, this server will mostly detect
"person" and nothing else construction-specific.

To get REAL hazard classes (No-Hardhat, No-Safety Vest, No-Mask, etc.) you
need a model trained on a PPE/construction-safety dataset. Search
"Construction Site Safety" on Roboflow Universe — several public projects
there use exactly these 10 classes: Hardhat, Mask, NO-Hardhat, NO-Mask,
NO-Safety Vest, Person, Safety Cone, Safety Vest, Machinery, Vehicle.
Once you download a trained .pt file (or train your own with `ultralytics`),
just change MODEL_PATH below to point at that file — nothing else in this
code needs to change, because CLASS_TO_HAZARD (further down) already knows
about those exact class names.

--------------------------------------------------------------------------
"""

import base64
import io
from typing import List

import cv2
import numpy as np
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

# ==============================================================================
# 1. CONFIGURATION — the settings you're most likely to change later
# ==============================================================================

# Path (or name) of the YOLO model to load.
# "yolov8n.pt" = stock model, auto-downloaded by ultralytics on first run.
# Swap this for your own trained weights file later, e.g. "hazard_model.pt".
MODEL_PATH = "yolov8n.pt"

# Minimum confidence (0-1) for YOLO to even report a detection.
# Lower = more (but noisier) detections. 0.25 is a sane starting point.
CONFIDENCE_THRESHOLD = 0.25

# The order hazards are ranked in, worst first. Used for sorting the
# "hazards" list in the response so the most dangerous thing is always h1.
TIER_ORDER = {"Fatal": 0, "Dangerous": 1, "High": 2, "Medium": 3, "Low": 4}


# ==============================================================================
# 2. CLASS → HAZARD MAPPING
# ==============================================================================
# This dictionary is the "brain" that turns a raw YOLO class name (e.g.
# "NO-Hardhat") into a human-readable hazard card with a severity tier and
# suggested actions — matching the SafeSightAI+ hazard vocabulary.
#
# Keys are normalized (lowercase, spaces/dashes removed) so "NO-Hardhat",
# "no hardhat", and "no_hardhat" all match the same entry.
#
# Classes NOT listed here (e.g. plain "person", "hardhat", "safety vest",
# "vehicle") are treated as SAFE / neutral objects and are not turned into
# hazards — they still show up in the "detections" list, just not in
# "hazards".
#
# The last few entries (live_wire, exposed_rebar, scaffolding_risk,
# slip_trip, no_harness) are FORWARD-COMPATIBLE placeholders: the stock
# YOLOv8n model will never produce these class names, but if you later
# train a custom model with these exact class names, they'll be picked up
# automatically with zero code changes.
# ==============================================================================

def _normalize(name: str) -> str:
    """Turn 'NO-Hardhat' or 'no hardhat' into 'nohardhat' so matching is easy."""
    return name.strip().lower().replace(" ", "").replace("-", "").replace("_", "")


CLASS_TO_HAZARD = {
    _normalize("NO-Hardhat"): {
        "title": "No Helmet Detected",
        "severity": "Medium",
        "description": "Worker detected without a hard hat.",
        "actions": ["Issue helmet immediately", "Stop work until PPE is worn", "Log worker ID"],
    },
    _normalize("NO-Safety Vest"): {
        "title": "No Safety Vest Detected",
        "severity": "Medium",
        "description": "Worker detected without a high-visibility safety vest.",
        "actions": ["Provide safety vest on the spot", "Log worker ID", "Flag for retraining"],
    },
    _normalize("NO-Mask"): {
        "title": "No Mask Detected",
        "severity": "Low",
        "description": "Worker detected without a protective mask in a dust/fume-prone area.",
        "actions": ["Provide mask on the spot", "Log worker ID"],
    },
    # ---- Forward-compatible placeholders for a future custom-trained model ----
    _normalize("live_wire"): {
        "title": "Unearthed Live Wire",
        "severity": "Dangerous",
        "description": "Exposed or frayed electrical wiring detected.",
        "actions": ["Isolate power immediately", "Cordon off the area", "Notify electrical safety officer"],
    },
    _normalize("exposed_rebar"): {
        "title": "Exposed Reinforcement",
        "severity": "High",
        "description": "Protruding rebar without a safety cap detected.",
        "actions": ["Cap exposed rebar", "Barricade the zone", "Notify structural engineer"],
    },
    _normalize("scaffolding_risk"): {
        "title": "Scaffolding Risk",
        "severity": "High",
        "description": "Misaligned or unsafe scaffolding detected.",
        "actions": ["Stop scaffold use", "Engineer inspection", "Re-certify before reuse"],
    },
    _normalize("slip_trip"): {
        "title": "Slip / Trip Hazard",
        "severity": "Low",
        "description": "Debris or an uneven walking surface detected.",
        "actions": ["Clear debris immediately", "Barricade the area", "Re-inspect in 24h"],
    },
    _normalize("no_harness"): {
        "title": "No Harness Detected",
        "severity": "Dangerous",
        "description": "Worker at height detected without a visible fall-arrest harness.",
        "actions": ["Halt work at height", "Issue harness", "Verify anchor point"],
    },
}


# ==============================================================================
# 3. LOAD THE MODEL (happens ONCE, when the server starts — not per request)
# ==============================================================================
print(f"Loading YOLO model from '{MODEL_PATH}' ... (first run may download it)")
model = YOLO(MODEL_PATH)
print("Model loaded. Classes this model knows:", model.names)


# ==============================================================================
# 4. SET UP THE WEB SERVER
# ==============================================================================
app = FastAPI(title="SafeSightAI+ YOLO Engine")

# CORS = "Cross-Origin Resource Sharing". Without this, a webpage running
# on a different address (e.g. your React/HTML frontend) would be BLOCKED
# by the browser from calling this API. allow_origins=["*"] means "allow
# any website to call this" — fine for a hackathon demo, but you'd lock
# this down to your actual frontend's address in a real product.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def health_check():
    """
    Visit http://127.0.0.1:8000 in your browser — if you see this message,
    the server is running correctly.
    """
    return {"status": "SafeSightAI+ YOLO Engine is running", "model": MODEL_PATH}


@app.post("/detect")
async def detect(file: UploadFile = File(...)):
    """
    THE MAIN ENDPOINT.

    Send a POST request to /detect with an image file attached (form field
    name doesn't matter, FastAPI reads it via `file`). You can test this
    with zero coding by visiting http://127.0.0.1:8000/docs — FastAPI
    auto-generates a page there where you can upload an image with a
    button click and see the JSON response.

    Returns:
        {
          "annotated_image": "<base64 JPEG string, with boxes drawn>",
          "detections": [ {"class": "...", "confidence": 0.9, "box": [x1,y1,x2,y2]}, ... ],
          "hazards":    [ {"id": "h1", "title": "...", "severity": "...", ...}, ... ]
        }
    """

    # ---- STEP 1: read the uploaded file into memory ----
    file_bytes = await file.read()

    # ---- STEP 2: decode those bytes into an image OpenCV can work with ----
    # np.frombuffer turns the raw bytes into a numpy array of numbers.
    # cv2.imdecode then interprets those numbers as an actual image (BGR format).
    np_array = np.frombuffer(file_bytes, dtype=np.uint8)
    image = cv2.imdecode(np_array, cv2.IMREAD_COLOR)

    if image is None:
        # The uploaded file wasn't a readable image (wrong format, corrupted, etc.)
        return {"error": "Could not read the uploaded file as an image. Please upload a JPG or PNG."}

    # ---- STEP 3: run YOLO detection on the image ----
    # model.predict() does the actual AI work. `verbose=False` just keeps
    # the terminal output clean.
    results = model.predict(source=image, conf=CONFIDENCE_THRESHOLD, verbose=False)
    result = results[0]  # we only sent one image, so we only need the first result

    # ---- STEP 4: get the annotated image (boxes drawn on it) ----
    # result.plot() returns a numpy image (BGR) with all the boxes and
    # labels already drawn on it — no manual drawing code needed.
    annotated_bgr = result.plot()

    # Encode that image as a JPEG in memory, then convert to base64 text
    # (base64 = a way to represent binary image data as plain text, so it
    # can travel safely inside JSON).
    success, encoded_jpeg = cv2.imencode(".jpg", annotated_bgr)
    annotated_image_base64 = base64.b64encode(encoded_jpeg.tobytes()).decode("utf-8")

    # ---- STEP 5: build the plain "detections" list ----
    detections: List[dict] = []
    for box in result.boxes:
        class_id = int(box.cls[0])
        class_name = model.names[class_id]
        confidence = float(box.conf[0])
        x1, y1, x2, y2 = box.xyxy[0].tolist()  # bounding box corners

        detections.append({
            "class": class_name,
            "confidence": round(confidence, 2),
            "box": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
        })

    # ---- STEP 6: turn detections into ranked hazards ----
    hazards: List[dict] = []
    hazard_counter = 1
    for det in detections:
        key = _normalize(det["class"])
        hazard_info = CLASS_TO_HAZARD.get(key)
        if hazard_info is None:
            continue  # this object isn't a hazard (e.g. plain "person", "vehicle")

        hazards.append({
            "id": f"h{hazard_counter}",
            "title": hazard_info["title"],
            "severity": hazard_info["severity"],
            "confidence": det["confidence"],
            "description": hazard_info["description"],
            "actions": hazard_info["actions"],
        })
        hazard_counter += 1

    # Sort hazards worst-first: Fatal, then Dangerous, then High, Medium, Low.
    # If two hazards share a tier, the higher-confidence one comes first.
    hazards.sort(key=lambda h: (TIER_ORDER.get(h["severity"], 99), -h["confidence"]))

    # Re-number ids after sorting, so h1 really is the most severe hazard.
    for i, hazard in enumerate(hazards, start=1):
        hazard["id"] = f"h{i}"

    # ---- STEP 7: send everything back ----
    return {
        "annotated_image": annotated_image_base64,
        "detections": detections,
        "hazards": hazards,
    }


# ==============================================================================
# 5. RUN DIRECTLY (optional — normally you'll start this with the uvicorn
#    command in the terminal instead, see the instructions given alongside
#    this file). This block just lets `python main.py` also work.
# ==============================================================================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
