#!/usr/bin/env python3
"""Default live public/synthetic typed triage, with explicit offline modes."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.request

ENDPOINT = "https://opencode.ai/zen/v1/systemone"
MODEL = "jev-1.13-free"
KEY_PATHS = (Path.home() / ".jev/zen.key", Path.home() / ".zcode/skills/typesafe-ai/zen.key")


def key_present():
    if "ZEN_API_KEY" in os.environ:
        return True
    for path in KEY_PATHS:
        try:
            if path.is_file():
                return True
        except OSError:
            continue
    return False


def load_key():
    key = os.environ.get("ZEN_API_KEY", "").strip()
    if key:
        return key
    for path in KEY_PATHS:
        try:
            key = path.read_text(encoding="utf-8").strip()
            if key:
                return key
        except OSError:
            continue
    return None


def probability(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1


def accounting(response, mode="live"):
    # Only numeric service counters leave the client, never arbitrary response text.
    response = response if isinstance(response, dict) else {}
    usage = response.get("usage")
    if not isinstance(usage, dict) or not all(
            isinstance(k, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", k)
            and type(v) in (int, float) and math.isfinite(v) and v >= 0
            for k, v in usage.items()):
        usage = None
    cost = response.get("cost")
    if type(cost) not in (int, float) or not math.isfinite(cost) or cost < 0:
        cost = None
    return {"usage": usage, "cost": cost,
            "cost_source": ("service" if mode == "live" else "mock") if cost is not None else "unknown"}


def validate_request(req):
    if not isinstance(req, dict) or set(req) != {"purpose", "data_class", "state", "questions"}:
        raise ValueError("request_contract")
    if req["purpose"] != "triage" or req["data_class"] not in ("synthetic", "public"):
        raise ValueError("input_scope")
    questions = req["questions"]
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 20:
        raise ValueError("questions_contract")
    for qid, question in questions.items():
        if not isinstance(qid, str) or not qid or not isinstance(question, dict):
            raise ValueError("question_contract")
        if set(question) != {"type", "instructions", "criteria"}:
            raise ValueError("question_contract")
        kind, criteria = question["type"], question["criteria"]
        if not isinstance(question["instructions"], str) or not question["instructions"].strip():
            raise ValueError("question_contract")
        if kind == "noul":
            valid = isinstance(criteria, dict) and set(criteria) == {"true", "false"}
        elif kind == "choice":
            valid = isinstance(criteria, dict) and len(criteria) >= 2 and all(isinstance(k, str) and k for k in criteria)
        elif kind == "score":
            valid = isinstance(criteria, list) and len(criteria) >= 2
        else:
            valid = False
        values = criteria.values() if isinstance(criteria, dict) else criteria if isinstance(criteria, list) else []
        if not valid or not all(isinstance(x, str) and x.strip() for x in values):
            raise ValueError("criteria_contract")
    body = {"state": req["state"], "questions": questions, "model": MODEL}
    if len(json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 65536:
        raise ValueError("payload_too_large")
    return body


def validate_response(req, response, threshold=0.8):
    if not isinstance(response, dict) or not isinstance(response.get("answers"), dict):
        raise ValueError("response_contract")
    answers, questions = response["answers"], req["questions"]
    if set(answers) != set(questions):
        raise ValueError("answer_ids")
    result = {}
    for qid, question in questions.items():
        ans, kind = answers[qid], question["type"]
        if not isinstance(ans, dict) or ans.get("type") != kind:
            raise ValueError("answer_type")
        if kind == "noul":
            value = ans.get("noul")
            if not probability(value):
                raise ValueError("probability_contract")
            confidence = max(value, 1 - value)
        else:
            confidence, probs = ans.get("confidence"), ans.get("probabilities")
            options = set(question["criteria"]) if kind == "choice" else {str(i) for i in range(len(question["criteria"]))}
            if not probability(confidence) or not isinstance(probs, dict) or set(probs) != options:
                raise ValueError("probability_contract")
            if not all(probability(p) for p in probs.values()) or abs(sum(probs.values()) - 1) > 0.02:
                raise ValueError("probability_contract")
            value = ans.get(kind)
            if kind == "choice":
                if value not in options or probs[value] < max(probs.values()) - 0.001:
                    raise ValueError("choice_contract")
            elif type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= len(options) - 1:
                raise ValueError("score_contract")
            if kind == "choice":
                confidence = min(confidence, probs[value])
            else:
                confidence = min(confidence, max(probs.values()))
        if confidence < threshold:
            raise ValueError("low_confidence")
        result[qid] = {"type": kind, "value": value, "confidence": confidence}
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def call_live(body, key, telemetry=None):
    opener = urllib.request.build_opener(NoRedirect())
    data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
    for attempt in range(2):
        request = urllib.request.Request(ENDPOINT, data=data, headers={
            "Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": "curl/8.9.1"})
        try:
            if telemetry is not None:
                telemetry["request_attempts"] += 1
            with opener.open(request, timeout=15) as response:
                raw = response.read(1_048_577)
                if len(raw) > 1_048_576:
                    raise ValueError("response_too_large")
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as error:
            retry = error.code == 429 or 500 <= error.code < 600
            error.close()
            if not retry or attempt == 1:
                raise ValueError("http_failure") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == 1:
                raise ValueError("network_failure") from None
        if attempt == 0:
            time.sleep(1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", nargs="?", help="request JSON file or stdin")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--mock-response", help="offline response JSON file")
    mode.add_argument("--live", action="store_true", help="explicitly select the default live mode")
    mode.add_argument("--offline", action="store_true", help="skip network and return to Sol/root")
    mode.add_argument("--check-key", action="store_true")
    parser.add_argument("--allow-external", action="store_true", help="legacy compatibility flag; public/synthetic triage is already authorized")
    parser.add_argument("--threshold", type=float, default=0.8)
    args = parser.parse_args(argv)
    if args.check_key:
        print(json.dumps({"key_present": key_present(), "live_verified": False}))
        return 0
    run_mode = "mock" if args.mock_response else "offline" if args.offline else "live"
    telemetry = {"mode": run_mode, "live_attempted": False, "request_attempts": 0}
    response = None
    started = time.monotonic()
    try:
        if not probability(args.threshold) or args.threshold < 0.5:
            raise ValueError("threshold_contract")
        data = Path(args.request).read_bytes() if args.request else sys.stdin.buffer.read(65537)
        if len(data) > 65536:
            raise ValueError("payload_too_large")
        req = json.loads(data.decode("utf-8"))
        body = validate_request(req)
        if args.offline:
            raise ValueError("offline_selected")
        if args.mock_response:
            response = json.loads(Path(args.mock_response).read_text(encoding="utf-8"))
        else:
            key = load_key()
            if not key:
                raise ValueError("no_key")
            telemetry["live_attempted"] = True
            response = call_live(body, key, telemetry)
        answers = validate_response(req, response, args.threshold)
        telemetry["elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
        print(json.dumps({"status": "ok", **telemetry, "answers": answers, **accounting(response, run_mode)}, ensure_ascii=False))
        return 0
    except (ValueError, OSError, UnicodeError, TypeError) as error:
        reasons = {"request_contract", "input_scope", "questions_contract", "question_contract", "criteria_contract",
                   "payload_too_large", "response_contract", "answer_ids", "answer_type", "probability_contract",
                   "choice_contract", "score_contract", "low_confidence", "response_too_large", "http_failure",
                   "network_failure", "threshold_contract", "offline_selected", "no_key"}
        reason = str(error) if type(error) is ValueError and str(error) in reasons else "invalid_input_or_response"
        telemetry["elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
        print(json.dumps({"status": "fallback", "owner": "sol-or-root", "reason": reason, **telemetry, **accounting(response, run_mode)}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
