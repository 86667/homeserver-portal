'use client';

import { type ReactNode, useState } from 'react';
import { Activity, Server, UserRound } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { AccountConfig } from '../model';
import { AccountTab } from './AccountTab';
import { ActivityTab } from './ActivityTab';
import { HomeserverTab } from './HomeserverTab';
import { PageFooter } from './PageFooter';
import { PageHeader } from './PageHeader';
import { useAccountFlow } from '../useAccountFlow';
import { useOwnActivity } from '../useOwnActivity';
import { useHomeserver } from '../useHomeserver';
import { useProfile } from '../useProfile';

type Tab = 'homeserver' | 'account' | 'activity';

interface AccountFlowProps {
  /** null: the page is not set up (no usable homeserver key configured). */
  config: AccountConfig | null;
  /** The invite code from the page's link, if any. */
  initialCode: string;
}

/**
 * The public page of a homeserver, in tabs: facts about the homeserver, the
 * visitor's account (sign up or sign in with Pubky Ring, then what they have
 * here) and, once signed in, their own activity on it. Nothing is stored;
 * reloading signs out.
 */
export function AccountFlow({ config, initialCode }: AccountFlowProps) {
  return config ? <ConnectedTabs config={config} initialCode={initialCode} /> : <NotSetUpTabs />;
}

/**
 * Holds the sign-in and what was loaded for each tab, so switching tabs
 * keeps it all. A tab's data is read when it is first opened.
 */
function ConnectedTabs({ config, initialCode }: { config: AccountConfig; initialCode: string }) {
  // An invite link is for signing up, so it opens on the Account tab.
  const [tab, setTab] = useState<Tab>(initialCode ? 'account' : 'homeserver');
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set([tab]));
  const open = (next: string) => {
    setTab(next as Tab);
    setOpened((current) => (current.has(next as Tab) ? current : new Set(current).add(next as Tab)));
  };

  const flow = useAccountFlow(config, initialCode);
  const signedIn = flow.step.name === 'done' && flow.step.info.hasAccount ? flow.step.info.pubky : null;
  const profile = useProfile(flow.client, signedIn);
  const own = useOwnActivity(flow.client, signedIn, opened.has('activity'));
  const homeserver = useHomeserver(flow.client, opened.has('homeserver'));
  // Back where the sign-in is, whichever tab the person was on.
  const signOut = () => {
    flow.backToStart();
    setTab('account');
  };
  // The header's sign-in: the QR code appears on the Account tab.
  const signIn =
    flow.step.name === 'start'
      ? () => {
          open('account');
          void flow.start('signin');
        }
      : null;

  return (
    <AccountPage signedIn={signedIn} onSignOut={signOut} onSignIn={signIn}>
      <PageTabs
        value={tab}
        onChange={open}
        homeserver={
          <HomeserverTab homeserver={config.homeserver} state={homeserver} inviteRequired={flow.inviteRequired} />
        }
        account={<AccountTab flow={flow} profile={profile} />}
        activity={signedIn && <ActivityTab own={own} />}
      />
    </AccountPage>
  );
}

function NotSetUpTabs() {
  const [tab, setTab] = useState<Tab>('homeserver');
  return (
    <AccountPage signedIn={null} onSignOut={() => undefined} onSignIn={null}>
      <PageTabs
        value={tab}
        onChange={(next) => setTab(next as Tab)}
        homeserver={
          <HomeserverTab
            homeserver=""
            state={{ info: { status: 'loading' }, record: { status: 'loading' } }}
            inviteRequired={null}
            notSetUp={<NotSetUp />}
          />
        }
        account={<NotSetUp />}
      />
    </AccountPage>
  );
}

/** The Activity tab is there only for a signed-in account holder: pass `activity` then. */
function PageTabs({
  value,
  onChange,
  homeserver,
  account,
  activity,
}: {
  value: Tab;
  onChange: (tab: string) => void;
  homeserver: ReactNode;
  account: ReactNode;
  activity?: ReactNode;
}) {
  return (
    <Tabs value={value} onValueChange={onChange} className="w-full">
      <TabsList
        className={cn(
          'flex w-full scrollbar-none flex-nowrap overflow-x-auto md:grid',
          activity ? 'md:grid-cols-3' : 'md:grid-cols-2',
        )}
      >
        <TabsTrigger
          value="homeserver"
          className="shrink-0 gap-2 text-xs sm:text-sm [&_svg]:size-4"
          data-testid="tab-homeserver"
        >
          <Server className="shrink-0" />
          Homeserver
        </TabsTrigger>
        <TabsTrigger
          value="account"
          className="shrink-0 gap-2 text-xs sm:text-sm [&_svg]:size-4"
          data-testid="tab-account"
        >
          <UserRound className="shrink-0" />
          Account
        </TabsTrigger>
        {activity && (
          <TabsTrigger
            value="activity"
            className="shrink-0 gap-2 text-xs sm:text-sm [&_svg]:size-4"
            data-testid="tab-activity"
          >
            <Activity className="shrink-0" />
            Activity
          </TabsTrigger>
        )}
      </TabsList>
      <TabsContent value="homeserver" className="space-y-4">
        {homeserver}
      </TabsContent>
      <TabsContent value="account" className="space-y-4">
        {account}
      </TabsContent>
      {activity && (
        <TabsContent value="activity" className="space-y-4">
          {activity}
        </TabsContent>
      )}
    </Tabs>
  );
}

function NotSetUp() {
  return (
    <Alert data-testid="account-not-set-up">
      <AlertTitle>This page is not set up yet</AlertTitle>
      <AlertDescription className="text-xs">
        The operator of this homeserver has not configured it. Check back later.
      </AlertDescription>
    </Alert>
  );
}

/** The page around the tabs, laid out like the admin dashboard: header, content, footer. */
function AccountPage({
  signedIn,
  onSignOut,
  onSignIn,
  children,
}: {
  signedIn: string | null;
  onSignOut: () => void;
  onSignIn: (() => void) | null;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main>
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-6 sm:gap-3 sm:px-6 sm:py-10">
          <PageHeader signedIn={signedIn} onSignOut={onSignOut} onSignIn={onSignIn} />
          {children}
        </div>
        <PageFooter />
      </main>
    </div>
  );
}
