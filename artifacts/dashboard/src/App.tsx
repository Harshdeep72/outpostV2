import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import Layout from "@/components/Layout";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import Overview from "@/pages/admin/Overview";
import Users from "@/pages/admin/Users";
import VerifiedUsers from "@/pages/admin/VerifiedUsers";
import PaymentMethods from "@/pages/admin/PaymentMethods";
import Tasks from "@/pages/admin/Tasks";
import Submissions from "@/pages/admin/Submissions";
import TasksByCreator from "@/pages/admin/TasksByCreator";
import Campaigns from "@/pages/admin/Campaigns";
import RedditTest from "@/pages/admin/RedditTest";
import RedditBulkCheck from "@/pages/admin/RedditBulkCheck";
import Console from "@/pages/admin/Console";
import Applications from "@/pages/admin/Applications";
import AdminUsers from "@/pages/admin/AdminUsers";
import CreateTask from "@/pages/admin/CreateTask";
import BulkTasks from "@/pages/admin/BulkTasks";
import Settings from "@/pages/admin/Settings";
import Cooldowns from "@/pages/admin/Cooldowns";
import Exports from "@/pages/admin/Exports";
import CreatorEarnings from "@/pages/admin/CreatorEarnings";
import WorkerProfile from "@/pages/admin/WorkerProfile";
import FraudSignals from "@/pages/admin/FraudSignals";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10000,
    },
  },
});

function ProtectedApp() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Switch>
        <Route path="/register" component={Register} />
        <Route path="/login" component={Login} />
        <Route component={Login} />
      </Switch>
    );
  }

  // 'dev' is higher than 'admin' and sees admin-only pages too.
  const isAdmin = user.role === "admin" || user.role === "dev";

  return (
    <Layout>
      <Switch>
        <Route path="/admin" component={Overview} />
        <Route path="/admin/verified" component={VerifiedUsers} />
        <Route path="/admin/payments" component={PaymentMethods} />
        <Route path="/admin/users" component={Users} />
        <Route path="/admin/tasks" component={Tasks} />
        <Route path="/admin/tasks/new" component={CreateTask} />
        <Route path="/admin/tasks/bulk" component={BulkTasks} />
        <Route path="/admin/submissions" component={Submissions} />
        <Route path="/admin/tasks-by-creator" component={TasksByCreator} />
        <Route path="/admin/exports" component={Exports} />
        <Route path="/admin/creator-earnings" component={CreatorEarnings} />
        <Route path="/admin/workers/:id" component={WorkerProfile} />
        <Route path="/admin/fraud-signals" component={FraudSignals} />
        <Route path="/admin/campaigns" component={Campaigns} />
        <Route path="/admin/reddit-test" component={RedditTest} />
        <Route path="/admin/reddit-bulk-check" component={RedditBulkCheck} />
        <Route path="/admin/console" component={Console} />
        {isAdmin && <Route path="/admin/settings" component={Settings} />}
        <Route path="/admin/cooldowns" component={Cooldowns} />
        {isAdmin && <Route path="/admin/applications" component={Applications} />}
        {isAdmin && <Route path="/admin/admin-users" component={AdminUsers} />}
        <Route path="/login"><Redirect to="/admin" /></Route>
        <Route path="/register"><Redirect to="/admin" /></Route>
        <Route path="/"><Redirect to="/admin" /></Route>
        <Route><Redirect to="/admin" /></Route>
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <ProtectedApp />
        </WouterRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
