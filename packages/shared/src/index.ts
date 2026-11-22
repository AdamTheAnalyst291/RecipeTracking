/** Response body of the API's health endpoint, shared by the API and the web app. */
export interface HealthResponse {
  status: "ok";
}

/** Response body of `GET /api/me`: who is signed in and their household. */
export interface MeResponse {
  name: string | null;
  household: { id: string };
}
