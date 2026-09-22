import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="card text-center !p-10">
      <div className="font-display accent-text text-6xl font-bold tracking-tight">
        404
      </div>
      <p className="mt-3 text-sm text-soft">
        The page you are looking for does not exist.
      </p>
      <Link to="/" className="btn-primary mt-6 inline-flex">
        Go to dashboard
      </Link>
    </div>
  );
}
