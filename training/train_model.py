# train_model.py
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, accuracy_score
import joblib
import re
import nltk

# Descargar stopwords si no se han descargado
nltk.download('stopwords')
from nltk.corpus import stopwords
spanish_stopwords = stopwords.words('spanish')

# Función de limpieza de texto
def clean_text(text):
    text = text.lower()
    text = re.sub(r'\W+', ' ', text)  # eliminar caracteres especiales
    words = text.split()
    words = [w for w in words if w not in spanish_stopwords]
    return " ".join(words)

# Cargar dataset
df = pd.read_csv("./training/tickets_mantenimiento.csv")  # ajusta ruta si es necesario
df['issue_clean'] = df['issue'].apply(clean_text)

# Variables
X = df['issue_clean']
y = df['priority']

# Vectorizar
vectorizer = TfidfVectorizer()
X_vect = vectorizer.fit_transform(X)

# Dividir en train/test
X_train, X_test, y_train, y_test = train_test_split(X_vect, y, test_size=0.2, random_state=42)

# Modelo
clf = RandomForestClassifier(random_state=42)
clf.fit(X_train, y_train)

# Predicción
y_pred = clf.predict(X_test)

# Reporte
print(classification_report(y_test, y_pred, zero_division=0))
print("Accuracy:", accuracy_score(y_test, y_pred))

# Guardar modelo y vectorizador
joblib.dump(clf, "./training/priority_model.joblib")
joblib.dump(vectorizer, "./training/vectorizer.joblib")
