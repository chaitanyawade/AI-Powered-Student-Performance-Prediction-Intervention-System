"""
EduPlus AI - offline training pipeline (model v2).

Predicts whether a student is AT RISK in the next exam: the next overall exam mark
is below 50 OR falls 12+ points below the student's recent average.

Pipeline: data -> 12 engineered features -> monotone, L2-regularised logistic regression
-> probability calibration (Platt) -> risk bands tuned on validation data -> held-out test report.
Everything the Node API needs is written to model/model.json (no Python at runtime).
The same feature maths lives in lib/model.js; test/parity.json proves both agree.

Usage:
    python ml/train.py                    # trains on the built-in synthetic school simulator
    python ml/train.py --csv real.csv     # trains on your own records (columns: the 12 FEATURES + at_risk)
    python ml/train.py --rows 20000 --seed 7
"""
import argparse, json, pathlib
import numpy as np
from scipy.optimize import minimize
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score
from sklearn.model_selection import StratifiedKFold, train_test_split

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASS = 40                      # a subject average below this counts as failing
AT_RISK_BELOW, DROP_POINTS = 50, 12   # label: next overall mark < 50, or 12+ points under the recent average
FEATURES = ["marks_recent", "marks_slope", "marks_volatility", "sudden_drop",
            "weakest_subject", "subjects_below_pass",
            "attendance", "attendance_trend", "weakest_subject_attendance",
            "quiz_average", "quiz_trend", "teacher_rating"]
# -1: higher is better (coefficient must be <= 0)   +1: higher is worse (coefficient must be >= 0)
SIGNS = [-1, -1, +1, -1, -1, +1, -1, -1, -1, -1, -1, -1]


# ----------------------------------------------------------------------------- features
def ols_slope(v):
    v = np.asarray(v, float)
    if len(v) < 2:
        return 0.0
    t = np.arange(len(v)) - (len(v) - 1) / 2
    return float((t * (v - v.mean())).sum() / (t ** 2).sum())


def features(c):
    """Canonical record -> 12 features. MUST match featuresFromCanon() in lib/model.js.
    c = {m: overall exam %, a: monthly attendance %, q: quiz %, t: teacher rating 1-5,
         subj: {subject: [exam %]}, att: {subject: [1 present / 0 absent]}}"""
    m = np.asarray(c["m"], float)
    last3 = m[-3:].mean()
    prev = m[:-1]
    z = (m[-1] - prev.mean()) / max(prev.std(), 5.0)
    smean = [np.mean(v) for v in c["subj"].values() if len(v)]
    a = np.asarray(c["a"], float)
    att_overall = a[-3:].mean()
    att_trend = a[-1] - a[max(0, len(a) - 4):-1].mean() if len(a) >= 2 else 0.0
    sub_att = [100 * np.mean(v) for v in c["att"].values() if len(v) >= 3]
    q = list(c["q"])[-5:]
    return [last3, ols_slope(m[-6:]), float(m[-5:].std()), min(z, 0.0),
            min(smean) if smean else last3, float(sum(v < PASS for v in smean)),
            att_overall, att_trend, min(sub_att) if sub_att else att_overall,
            float(np.mean(q)) if q else 60.0, ols_slope(q) if len(q) >= 3 else 0.0, float(c["t"])]


# ----------------------------------------------------------------------------- synthetic school
def simulate(n, seed):
    """A school simulator. Hidden next-exam dynamics include effects the features only
    approximate (attendance threshold, failing subjects, shocks), as in real life."""
    r = np.random.default_rng(seed)
    recs, y = [], []
    for _ in range(n):
        ability = float(np.clip(r.normal(64, 14), 20, 95))
        trend = r.normal(-0.3, 2.4)
        sigma = float(np.clip(r.lognormal(np.log(3.5), 0.35), 1.5, 9))
        off = r.normal(0, 7, 5)
        subj_exam = np.clip(ability + trend * (np.arange(6) - 5)[:, None] + off[None, :] + r.normal(0, sigma, (6, 5)), 0, 100)
        m = subj_exam.mean(1)                                   # overall exam % = mean of the five subjects
        subj = {f"s{j}": subj_exam[4:, j].tolist() for j in range(5)}   # current semester: last two exams
        att_level = float(np.clip(84 + 0.25 * (ability - 64) + r.normal(0, 8), 40, 100))
        drift = r.normal(-0.5, 2.0)
        a = np.clip(att_level + drift * (np.arange(6) - 5) + r.normal(0, 3, 6), 25, 100)
        att = {}
        for j in range(5):
            p = np.clip((a[-1] + r.normal(0, 5)) / 100, 0.05, 1.0)
            att[f"s{j}"] = (r.random(int(r.integers(12, 40))) < p).astype(int).tolist()
        nq = int(r.integers(0, 6))
        q = np.clip(ability + r.normal(0, 9, nq), 5, 100).tolist()
        t = int(np.clip(round(3 + (ability - 64) / 18 + r.normal(0, 0.8)), 1, 5))
        c = {"m": m.tolist(), "a": a.tolist(), "q": q, "t": t, "subj": subj, "att": att}

        smean = [np.mean(v) for v in subj.values()]
        fail = sum(v < PASS for v in smean)
        qmean = np.mean(q) if q else ability
        nxt = (ability + trend
               + 0.12 * (a[-1] - 80) - 0.15 * max(0.0, 75 - a[-1])          # low attendance hurts more below 75
               + 0.08 * (qmean - ability) + 1.3 * (t - 3)
               - 2.2 * fail - 0.6 * max(0.0, sigma - 4.5)
               - (r.normal(11, 4) if r.random() < 0.07 else 0.0)            # an unpredictable bad exam
               + r.normal(0, 4.2))
        last3 = float(np.mean(m[-3:]))
        recs.append(c)
        y.append(int(nxt < AT_RISK_BELOW or nxt < last3 - DROP_POINTS))
    return recs, np.array(y)


# ----------------------------------------------------------------------------- model
def sigmoid(z):
    return 1 / (1 + np.exp(-z))


def fit_monotone(Z, y, signs, l2):
    """L-BFGS logistic regression with sign constraints: higher marks can never raise risk, and so on.
    This keeps the model's explanations sensible."""
    n, k = Z.shape
    bounds = [((0, None) if s > 0 else (None, 0)) for s in signs] + [(None, None)]

    def loss(w):
        p = sigmoid(Z @ w[:k] + w[k])
        ll = -np.mean(y * np.log(p + 1e-12) + (1 - y) * np.log(1 - p + 1e-12)) + 0.5 * l2 * np.sum(w[:k] ** 2)
        return ll, np.r_[Z.T @ (p - y) / n + l2 * w[:k], np.mean(p - y)]

    res = minimize(loss, np.zeros(k + 1), jac=True, method="L-BFGS-B", bounds=bounds)
    return res.x[:k], res.x[k]


def ece(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    return float(sum((idx == b).mean() * abs(y[idx == b].mean() - p[idx == b].mean()) for b in range(bins) if (idx == b).any()))


def report(y, p, medium, high):
    risky = y == 1
    pred_m, pred_h = p >= medium, p >= high
    return {
        "auc": round(roc_auc_score(y, p), 3), "pr_auc": round(average_precision_score(y, p), 3),
        "brier": round(brier_score_loss(y, p), 3), "log_loss": round(log_loss(y, p), 3), "ece": round(ece(y, p), 3),
        "recall_at_medium": round(float((pred_m & risky).sum() / risky.sum()), 3),
        "precision_at_high": round(float((pred_h & risky).sum() / max(pred_h.sum(), 1)), 3),
        "flagged_share": round(float(pred_m.mean()), 3),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv"); ap.add_argument("--rows", type=int, default=12000); ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()

    if a.csv:
        d = np.genfromtxt(a.csv, delimiter=",", names=True)
        X, y, recs, source = np.c_[[d[c] for c in FEATURES]].T, d["at_risk"].astype(int), None, f"csv:{pathlib.Path(a.csv).name}"
    else:
        recs, y = simulate(a.rows, a.seed)
        X, source = np.array([features(c) for c in recs]), "synthetic school simulator"
    print(f"rows={len(y)}  at-risk rate={y.mean():.2f}  source={source}")

    # 60 / 20 / 20 split: fit / calibrate + tune bands / final untouched test
    Xtv, Xte, ytv, yte = train_test_split(X, y, test_size=0.2, random_state=1, stratify=y)
    Xtr, Xva, ytr, yva = train_test_split(Xtv, ytv, test_size=0.25, random_state=2, stratify=ytv)
    mean, scale = Xtr.mean(0), Xtr.std(0) + 1e-9
    Z = lambda M: (M - mean) / scale

    # choose the regularisation strength by 5-fold cross-validation on the training part
    best = None
    for l2 in (0.003, 0.01, 0.03, 0.1, 0.3):
        losses = []
        for tr, va in StratifiedKFold(5, shuffle=True, random_state=3).split(Xtr, ytr):
            w, b = fit_monotone(Z(Xtr[tr]), ytr[tr], SIGNS, l2)
            losses.append(log_loss(ytr[va], sigmoid(Z(Xtr[va]) @ w + b)))
        if best is None or np.mean(losses) < best[0]:
            best = (float(np.mean(losses)), l2)
    l2 = best[1]
    coef, intercept = fit_monotone(Z(Xtr), ytr, SIGNS, l2)
    logit = lambda M: Z(M) @ coef + intercept
    print(f"cross-validated L2={l2}   cv log-loss={best[0]:.3f}")

    # Platt calibration on the validation set
    cal = LogisticRegression(C=1e6).fit(logit(Xva)[:, None], yva)
    ca, cb = float(cal.coef_[0, 0]), float(cal.intercept_[0])
    prob = lambda M: sigmoid(ca * logit(M) + cb)

    # risk bands tuned on validation data: Medium maximises F1.5 (recall slightly favoured), High needs >= 75% precision
    pv = prob(Xva)
    grid = np.linspace(0.1, 0.9, 81)
    prec = np.array([((pv >= t) & (yva == 1)).sum() / max((pv >= t).sum(), 1) for t in grid])
    rec = np.array([((pv >= t) & (yva == 1)).sum() / (yva == 1).sum() for t in grid])
    f15 = (1 + 1.5 ** 2) * prec * rec / np.maximum(1.5 ** 2 * prec + rec, 1e-9)
    medium = float(np.clip(grid[int(np.argmax(f15))], 0.3, 0.5))
    high = float(np.clip(min([t for t, p_ in zip(grid, prec) if p_ >= 0.75 and t > medium + 0.1] or [0.65]), 0.55, 0.8))

    pt = prob(Xte)
    final = report(yte, pt, medium, high)
    print("held-out TEST:", final)

    # honest comparison on the same test rows
    compare = {}
    old = [0, 6, 1, 9, 11]                                       # what the first model saw: marks, attendance, slope, quiz, teacher
    mo, so = Xtr[:, old].mean(0), Xtr[:, old].std(0) + 1e-9
    wo, bo = fit_monotone((Xtr[:, old] - mo) / so, ytr, [-1] * 5, 0.03)
    compare["first_model_inputs_auc"] = round(roc_auc_score(yte, sigmoid(((Xte[:, old] - mo) / so) @ wo + bo)), 3)
    compare["simple_rule_auc"] = round(roc_auc_score(yte, (100 - Xte[:, 0]) / 100 + (Xte[:, 6] < 75) * 0.2), 3)
    gb = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.06, max_iter=250, random_state=0).fit(Xtr, ytr)
    compare["gradient_boosting_auc"] = round(roc_auc_score(yte, gb.predict_proba(Xte)[:, 1]), 3)
    print("comparison (test AUC):", compare)

    for i in np.argsort(-np.abs(coef)):
        print(f"  {FEATURES[i]:28s} {coef[i]:+.3f}")

    out = {
        "version": "2.0", "type": "logistic_regression", "features": FEATURES, "signs": SIGNS,
        "mean": mean.tolist(), "scale": scale.tolist(), "coef": coef.tolist(), "intercept": float(intercept),
        "calib": {"a": ca, "b": cb}, "bands": {"medium": round(medium, 3), "high": round(high, 3)},
        "metrics": {**final, "rows": int(len(y)), "at_risk_rate": round(float(y.mean()), 3), "l2": l2},
        "card": {
            "label": "at risk next exam = next overall mark below 50, or 12+ points below the recent average",
            "data": source, "split": "60% fit / 20% calibrate + tune bands / 20% untouched test",
            "compare": compare, "trained_with": "monotone L2 logistic regression + Platt calibration",
        },
    }
    (ROOT / "model").mkdir(exist_ok=True)
    (ROOT / "model" / "model.json").write_text(json.dumps(out, indent=2))

    # parity fixtures: JavaScript must reproduce these features and probabilities exactly
    if recs:
        fx = []
        for c in [recs[i] for i in range(0, 600, 100)]:
            x = np.array(features(c))
            fx.append({"canon": c, "x": x.tolist(), "p": float(prob(x[None, :])[0])})
        (ROOT / "test").mkdir(exist_ok=True)
        (ROOT / "test" / "parity.json").write_text(json.dumps(fx))
    print("saved model/model.json")


if __name__ == "__main__":
    main()
