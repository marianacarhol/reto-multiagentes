# pip install fastapi uvicorn joblib pandas numpy pydantic
import joblib, pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel

pipe = joblib.load("priority_model.joblib")
LABELS = list(pipe.classes_)  # p.ej. ['high','low','medium']

THRESH_NEEDS_REVIEW = 0.55  # si ninguna clase supera esto, pedir revisión

class Payload(BaseModel):
    text: str
    domain: str  # 'rb' | 'm'
    vip: int     # 0|1
    spend30d: float
    eta_to_sla_min: float

app = FastAPI(title="PriorityModel v1")

@app.post("/predict")
def predict(p: Payload):
    X = pd.DataFrame([{
        "text": p.text,
        "domain": p.domain,
        "vip": int(p.vip),
        "spend30d": float(p.spend30d),
        "eta_to_sla_min": float(p.eta_to_sla_min),
    }])
    proba = pipe.predict_proba(X)[0]
    score = float(proba.max())
    label = LABELS[proba.argmax()]
    needs_review = score < THRESH_NEEDS_REVIEW
    return {
        "priority": label,
        "score": round(100*score),
        "proba": {lab: float(pr) for lab, pr in zip(LABELS, proba)},
        "needs_review": needs_review,
        "model": "tfidf_logreg_v1"
    }
