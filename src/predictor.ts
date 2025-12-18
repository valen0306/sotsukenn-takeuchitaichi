export interface Prediction {
  id: string;
  type: string;
  score?: number;
}

export interface Predictor {
  predict(queries: { id: string; query: string }[]): Promise<Prediction[]>;
}

