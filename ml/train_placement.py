"""
EduPlus AI - trains the PLACEMENT model (role fit + skill gap).

For every (student, job role) pair the model estimates the chance the student would be shortlisted.
Input: for each skill, "how far below the role's requirement is the student, weighted by how
important that skill is for the role". The learned weights say how much each missing skill hurts
a candidate's chances, so they also decide which gaps to fix first.

Weights are constrained to be >= 0, so improving a skill can never lower someone's fit.
The website keeps teaching this model from real placement results the TPO records.

Usage:   python ml/train_placement.py
Output:  model/placement.json
"""
import json, pathlib
import numpy as np
from scipy.optimize import minimize
from sklearn.metrics import roc_auc_score

ROOT = pathlib.Path(__file__).resolve().parent.parent
cat = json.loads((ROOT / "model" / "careers.json").read_text())
SKILLS = [s["key"] for s in cat["skills"]]
ROLES = cat["roles"]
K = len(SKILLS)


def features(levels, role):
    """x_i = (importance share of skill i in the role) * (shortfall of skill i, 0 to 1)"""
    req = role["req"]
    total = sum(imp for _, imp in req.values())
    x = np.zeros(K)
    for skill, (need, imp) in req.items():
        i = SKILLS.index(skill)
        x[i] = imp / total * max(0.0, 1 - levels[i] / need)
    return x


def synth(n=12000, seed=11):
    """Synthetic recruiter decisions. Replace with real placement records when you have them."""
    r = np.random.default_rng(seed)
    X, y = [], []
    boost = np.ones(K); boost[SKILLS.index("comm")] = 1.5; boost[SKILLS.index("ps")] = 1.2   # recruiters weigh these more
    for _ in range(n):
        ability = r.normal(55, 16)
        levels = np.clip(ability + r.normal(0, 14, K), 0, 100)
        role = ROLES[r.integers(len(ROLES))]
        req = role["req"]
        num = den = 0.0
        for skill, (need, imp) in req.items():
            i = SKILLS.index(skill)
            num += imp * boost[i] * min(levels[i] / need, 1.1)
            den += imp * boost[i]
        score = num / den + r.normal(0, 0.07)
        X.append(features(levels, role)); y.append(1 if score > 0.86 else 0)
    return np.array(X), np.array(y)


def fit(X, y, l2=1e-4):
    """logit = b - sum(w_i * x_i),  w_i >= 0"""
    n, k = X.shape

    def loss(p):
        w, b = p[:k], p[k]
        z = b - X @ w
        pr = 1 / (1 + np.exp(-z))
        ll = -np.mean(y * np.log(pr + 1e-12) + (1 - y) * np.log(1 - pr + 1e-12))
        g = pr - y
        grad = np.r_[-(X.T @ g) / n + l2 * w, np.mean(g)]      # z = b - X.w, so dz/dw = -X
        return ll + 0.5 * l2 * np.sum(w ** 2), grad

    res = minimize(loss, np.r_[np.ones(k), 2.0], jac=True, method="L-BFGS-B", bounds=[(0, None)] * k + [(None, None)],
                   options={"maxiter": 20000, "maxfun": 50000, "ftol": 1e-13, "gtol": 1e-9})
    return res.x[:k], res.x[k]


if __name__ == "__main__":
    X, y = synth()
    cut = int(len(y) * 0.8)
    w, b = fit(X[:cut], y[:cut])
    pr = 1 / (1 + np.exp(-(b - X[cut:] @ w)))
    auc = roc_auc_score(y[cut:], pr)
    print(f"rows={len(y)}  shortlisted={y.mean():.2f}  AUC={auc:.3f}  bias={b:.2f}")
    for s, v in zip(SKILLS, w):
        print(f"  {s:6s} weight {v:.2f}")
    out = ROOT / "model" / "placement.json"
    out.write_text(json.dumps({"version": "1.0", "skills": SKILLS, "w": w.tolist(), "b": float(b),
                               "metrics": {"auc": round(float(auc), 3), "rows": int(len(y))}}, indent=2))
    print("saved", out)
