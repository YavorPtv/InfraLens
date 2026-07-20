import { NavLink } from "react-router-dom";
import { navItems } from "../routes";

export function Header() {
  return (
    <header className="site-header">
      <NavLink className="brand" to="/">
        <span className="brand-mark" aria-hidden="true">
          IL
        </span>
        <span>InfraLens</span>
      </NavLink>

      <nav className="site-nav" aria-label="Primary navigation">
        {navItems.map((item) => (
          <NavLink className="nav-link" end={item.path === "/"} key={item.path} to={item.path}>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
