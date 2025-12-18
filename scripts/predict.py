#!/usr/bin/env python3
import sys
import json


def load_model():
    # Dummy placeholder for future real model loading
    return None


def predict(model, queries):
    # Dummy: always return "any"
    predictions = []
    for q in queries:
        predictions.append({"id": q.get("id"), "type": "any", "score": 0.0})
    return predictions


def main():
    data = sys.stdin.read()
    obj = json.loads(data)
    queries = obj.get("queries", [])
    model = load_model()
    preds = predict(model, queries)
    sys.stdout.write(json.dumps({"predictions": preds}))


if __name__ == "__main__":
    main()

