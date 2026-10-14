"""
EduPlus AI - offline model training.

Trains a logistic-regression model that predicts whether a student's next exam
will fall noticeably below their recent average ("academic decline").
Output: model/model.json  (read by the Node API, no Python needed at runtime).

Usage:
    python ml/train.py                  # trains on synthetic data (demo)
    python ml/train.py --csv real.csv   # trains on your own data (see README)

CSV columns (one row per student-exam):
    marks_last3, attendance, marks_slope, quiz,
    teacher_rating, momentum, anomaly_z, declined
"""
import argparse, json, pathlib
import numpy as np
from scipy.optimize import minimize
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score, accuracy_score
from sklearn.preprocessing import StandardScaler

FEATURES = ["marks_last3", "attendance", "marks_slope", "quiz",
            "teacher_rating", "momentum", "anomaly_z"]
OUT = pathlib.Path(__file__).resolve().parent.parent / "model" / "model.json"


def synth(n=6000, seed=42):
    """Synthetic school data. Replace with real records for real use."""
    r = np.random.default_rng(seed)
    ability = r.normal(66, 14, n)
    trend = r.normal(-0.4, 2.6, n)
    att = np.clip(84 + 0.2 * (ability - 66) + r.normal(0, 8, n), 40, 100)
    quiz = np.clip(ability + r.normal(0, 7, n), 15, 100)
    teach = np.clip(np.round(3 + (ability - 66) / 18 + r.normal(0, .8, n)), 1, 5)
    t = np.arange(6)
    marks = ability[:, None] + trend[:, None] * (t - 5) + r.normal(0, 3.5, (n, 6))
    marks = np.clip(marks, 0, 100)

    last3 = marks[:, 3:].mean(1)
    slope = np.array([np.polyfit(t, row, 1)[0] for row in marks])
    momentum = marks[:, 3:].mean(1) - marks[:, :3].mean(1)
    prev = marks[:, :5]
    z = (marks[:, 5] - prev.mean(1)) / np.maximum(prev.std(1), 5)

    # Hidden "true" dynamics for the next exam (the model never sees this formula)
    nxt = (marks[:, 5] + trend + 0.12 * (att - 80) + 0.10 * (quiz - ability)
           + 1.4 * (teach - 3) + r.normal(0, 4.5, n))
    y = ((nxt < last3 - 3) | (nxt < 40)).astype(int)  # drops noticeably OR falls below pass mark
    X = np.c_[last3, att, slope, quiz, teach, momentum, np.minimum(z, 0)]
    return X, y


def load_csv(path):
    d = np.genfromtxt(path, delimiter=",", names=True)
    X = np.c_[[d[c] for c in FEATURES]].T
    return X, d["declined"].astype(int)


def fit_monotone(Z, y, l2=0.8):
    """Logistic regression where every feature has a coefficient <= 0.
    All seven features are 'higher is better', so higher values may never
    raise the predicted risk. This keeps the explanations sensible."""
    n, k = Z.shape

    def loss(w):
        z = Z @ w[:k] + w[k]
        p = 1 / (1 + np.exp(-z))
        ll = -np.mean(y * np.log(p + 1e-12) + (1 - y) * np.log(1 - p + 1e-12))
        g = np.r_[Z.T @ (p - y) / n + l2 * w[:k], np.mean(p - y)]
        return ll + .5 * l2 * np.sum(w[:k] ** 2), g

    res = minimize(loss, np.zeros(k + 1), jac=True, method="L-BFGS-B",
                   bounds=[(None, 0)] * k + [(None, None)])
    return res.x[:k], res.x[k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv")
    a = ap.parse_args()
    X, y = load_csv(a.csv) if a.csv else synth()
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=.2, random_state=1, stratify=y)
    sc = StandardScaler().fit(Xtr)
    coef, intercept = fit_monotone(sc.transform(Xtr), ytr)
    pr = 1 / (1 + np.exp(-(sc.transform(Xte) @ coef + intercept)))
    auc, acc = roc_auc_score(yte, pr), accuracy_score(yte, pr > .5)
    print(f"rows={len(y)}  decline rate={y.mean():.2f}  AUC={auc:.3f}  accuracy={acc:.3f}")
    for f, c in zip(FEATURES, coef):
        print(f"  {f:15s} {c:+.3f}")

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({
        "version": "1.0", "type": "logistic_regression", "features": FEATURES,
        "mean": sc.mean_.tolist(), "scale": sc.scale_.tolist(),
        "coef": coef.tolist(), "intercept": float(intercept),
        "metrics": {"auc": round(auc, 3), "accuracy": round(acc, 3), "rows": int(len(y))},
    }, indent=2))
    print("saved", OUT)


if __name__ == "__main__":
    main()
