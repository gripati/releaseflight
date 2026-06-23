import { redirect } from "next/navigation";

export default function RootPage(): never {
  // Root → login. The middleware will redirect to the active tenant dashboard
  // when an authenticated session is present.
  redirect("/login");
}
