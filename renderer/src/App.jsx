import ControlPage from "./pages/ControlPage";
import CliPage from "./pages/CliPage";

export function App() {
  const isCli = window.location.hash === "#/cli";
  return isCli ? <CliPage /> : <ControlPage />;
}

