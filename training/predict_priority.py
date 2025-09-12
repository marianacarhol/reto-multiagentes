# predict_priority.py
import joblib
import re
import nltk
nltk.download('stopwords')
from nltk.corpus import stopwords

spanish_stopwords = stopwords.words('spanish')

# Función de limpieza (igual que en entrenamiento)
def clean_text(text):
    text = text.lower()
    text = re.sub(r'\W+', ' ', text)
    words = text.split()
    words = [w for w in words if w not in spanish_stopwords]
    return " ".join(words)

# Cargar modelo y vectorizador
clf = joblib.load("training/priority_model.joblib")       # ruta según tu proyecto
vectorizer = joblib.load("training/vectorizer.joblib")

# Función para predecir prioridad
def predict_priority(issue_text):
    issue_clean = clean_text(issue_text)
    vect = vectorizer.transform([issue_clean])
    pred = clf.predict(vect)
    return pred[0]

# Ejemplo de uso
if __name__ == "__main__":
    ejemplo = "El aire acondicionado no funciona en la habitación 101"
    print("Predicted priority:", predict_priority(ejemplo))
