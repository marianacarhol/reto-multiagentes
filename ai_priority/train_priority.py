# pip install scikit-learn joblib pandas numpy
import pandas as pd, numpy as np, joblib
from sklearn.model_selection import train_test_split
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import StandardScaler, OneHotEncoder
from sklearn.pipeline import Pipeline
from sklearn.metrics import classification_report

CSV_PATH = "./ai_priority/tickets_priority_dataset.csv"
MODEL_PATH = "priority_model.joblib"

df = pd.read_csv(CSV_PATH)

text_col = "text"
num_cols = ["spend30d", "eta_to_sla_min"]
cat_cols = ["domain", "vip"]

pre = ColumnTransformer([
    ("tfidf", TfidfVectorizer(ngram_range=(1,2), min_df=2), text_col),
    ("num", StandardScaler(with_mean=False), num_cols),
    ("cat", OneHotEncoder(handle_unknown="ignore"), cat_cols),
])

clf = LogisticRegression(max_iter=200, class_weight="balanced", n_jobs=None)
pipe = Pipeline([("pre", pre), ("clf", clf)])

X = df[[text_col] + num_cols + cat_cols]
y = df["label"].astype(str)

Xtr, Xte, ytr, yte = train_test_split(
    X, y, test_size=0.2, stratify=y, random_state=42
)
pipe.fit(Xtr, ytr)

yp = pipe.predict(Xte)
print(classification_report(yte, yp))

joblib.dump(pipe, MODEL_PATH)
print(f"Modelo guardado en {MODEL_PATH}")
