import express from 'express';
const app = express();
const port = 8080;

app.get('/', (req, res) => {
  res.send('Hello from Floor Planner Backend!');
});

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});