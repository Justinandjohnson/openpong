import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { OwnerProfile, OwnerProfileInput } from "../../../packages/domain/src/agent.ts";
import {
  draftComplete,
  draftFromProfile,
  type ProfileDraft,
  profileInputFromDraft,
  showValue,
} from "./profile-fields.ts";
import { Button, Card, colors, ErrorNotice, Field, Mascot, s } from "./ui";
import { useWorkspace } from "./workspace";

interface ProfileState {
  profile: OwnerProfile | null;
  onboarded: boolean;
}
interface ProfileContextValue extends ProfileState {
  loaded: boolean;
  error: string;
  saving: boolean;
  refresh: () => Promise<void>;
  save: (input: OwnerProfileInput) => Promise<OwnerProfile>;
  editing: boolean;
  startEditing: () => void;
  stopEditing: () => void;
}
const ProfileContext = createContext<ProfileContextValue | null>(null);

/**
 * Reads `GET /api/agent/profile` and owns the onboarding/edit state for the
 * whole app. `onboarded:false` is the server saying this owner has no profile
 * row yet — there is no example identity behind it.
 */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const { api } = useWorkspace();
  const [state, setState] = useState<ProfileState>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const next = await api.request<{ profile: OwnerProfile | null; onboarded: boolean }>(
        "/api/agent/profile",
      );
      setState({ profile: next.profile, onboarded: next.onboarded && Boolean(next.profile) });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [api]);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  const save = useCallback(
    async (input: OwnerProfileInput) => {
      setSaving(true);
      try {
        const saved = await api.request<OwnerProfile>("/api/agent/profile", input, "PUT");
        setState({ profile: saved, onboarded: Boolean(saved.displayName?.trim()) });
        setError("");
        return saved;
      } finally {
        setSaving(false);
      }
    },
    [api],
  );
  return (
    <ProfileContext.Provider
      value={{
        profile: state?.profile ?? null,
        onboarded: state?.onboarded ?? false,
        loaded: state !== undefined,
        error,
        saving,
        refresh,
        save,
        editing,
        startEditing: () => setEditing(true),
        stopEditing: () => setEditing(false),
      }}
    >
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile() {
  const context = useContext(ProfileContext);
  if (!context) throw new Error("The profile is unavailable");
  return context;
}

/**
 * First-run gate: until the server says this owner has a profile, the app
 * shows guided setup instead of a workspace that assumes someone else.
 */
export function ProfileGate({ children }: { children: ReactNode }) {
  const { onboarded, loaded, error, editing, stopEditing, refresh } = useProfile();
  if (!loaded)
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: colors.canvas,
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 24,
        }}
      >
        <Mascot size={56} />
        {error ? (
          <>
            <ErrorNotice error={error} />
            <Button onPress={() => void refresh().catch(() => {})}>Try again</Button>
          </>
        ) : (
          <>
            <ActivityIndicator color={colors.blueDark} />
            <Text style={s.muted}>Checking your setup…</Text>
          </>
        )}
      </SafeAreaView>
    );
  // A failed profile read must not force guided setup over an existing profile.
  if (!error && (editing || !onboarded))
    return (
      <OnboardingFlow
        mode={onboarded ? "edit" : "first-run"}
        onDone={stopEditing}
        {...(onboarded ? { onCancel: stopEditing } : {})}
      />
    );
  return <>{children}</>;
}

const steps = [
  {
    title: "Who are you?",
    detail: "Your own name and, if you have one, your USATT number.",
  },
  {
    title: "Where do you play?",
    detail: "The region, cities, states and clubs that make up your area.",
  },
  {
    title: "What do you follow?",
    detail: "League or tournament links you want the agent to keep up with.",
  },
];

export function OnboardingFlow({
  mode,
  onDone,
  onCancel,
}: {
  mode: "first-run" | "edit";
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { profile, save, saving } = useProfile();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(profile));
  const [problem, setProblem] = useState("");
  const update = (patch: Partial<ProfileDraft>) => setDraft({ ...draft, ...patch });
  const last = step === steps.length - 1;
  async function finish() {
    if (!draftComplete(draft)) {
      setProblem("Enter your name to continue.");
      setStep(0);
      return;
    }
    setProblem("");
    try {
      await save(profileInputFromDraft(draft));
      onDone();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }
  function next() {
    if (step === 0 && !draftComplete(draft)) {
      setProblem("Enter your name to continue.");
      return;
    }
    setProblem("");
    setStep(Math.min(step + 1, steps.length - 1));
  }
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }} edges={["top", "bottom"]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: 24,
          gap: 20,
          width: "100%",
          maxWidth: 560,
          alignSelf: "center",
        }}
      >
        <View style={{ alignItems: "center", gap: 10, paddingTop: 12 }}>
          <Mascot size={64} />
          <Text style={[s.title, { fontSize: 28, textAlign: "center" }]}>
            {mode === "first-run" ? "Welcome to OpenPong." : "Your profile"}
          </Text>
          <Text style={[s.muted, { textAlign: "center" }]}>
            {mode === "first-run"
              ? "Three short steps and the agent works for you: your name, your area, your leagues."
              : "Update your details, or rerun the guided setup."}
          </Text>
        </View>
        <View style={[s.row, { gap: 6, justifyContent: "center" }]}>
          {steps.map((item, index) => (
            <View
              key={item.title}
              style={{
                height: 5,
                width: index === step ? 34 : 18,
                borderRadius: 3,
                backgroundColor: index <= step ? colors.blueDark : colors.line,
              }}
            />
          ))}
        </View>
        <Card style={{ gap: 14 }}>
          <View style={{ gap: 4 }}>
            <Text style={s.label}>
              Step {step + 1} of {steps.length}
            </Text>
            <Text style={s.heading}>{steps[step]?.title}</Text>
            <Text style={s.muted}>{steps[step]?.detail}</Text>
          </View>
          {step === 0 && (
            <>
              <Field
                label="Your name"
                value={draft.displayName}
                onChangeText={(displayName) => update({ displayName })}
                placeholder="Your name"
                autoFocus
              />
              <Field
                label="USATT number (optional)"
                value={draft.usattId}
                onChangeText={(usattId) => update({ usattId })}
                placeholder="Your USATT id"
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
              />
            </>
          )}
          {step === 1 && (
            <>
              <Field
                label="Home region (optional)"
                value={draft.homeRegion}
                onChangeText={(homeRegion) => update({ homeRegion })}
                placeholder="A region number or label"
              />
              <Field
                label="Cities (optional)"
                value={draft.cities}
                onChangeText={(cities) => update({ cities })}
                placeholder="Cities, separated by commas"
              />
              <Field
                label="States (optional)"
                value={draft.states}
                onChangeText={(states) => update({ states })}
                placeholder="States, separated by commas"
              />
              <Field
                label="Clubs (optional)"
                value={draft.clubs}
                onChangeText={(clubs) => update({ clubs })}
                placeholder="Clubs you play at"
              />
            </>
          )}
          {step === 2 && (
            <Field
              label="League or tournament links (optional)"
              value={draft.leagueUrls}
              onChangeText={(leagueUrls) => update({ leagueUrls })}
              placeholder="One link per line"
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />
          )}
          <Text style={s.small}>
            Everything here is yours and can be changed later in Settings. Only your name is
            required.
          </Text>
        </Card>
        <ErrorNotice error={problem} />
        <View style={[s.row, { gap: 10, justifyContent: "space-between" }]}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {step > 0 && (
              <Button small onPress={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            {onCancel && (
              <Button small onPress={onCancel}>
                Cancel
              </Button>
            )}
          </View>
          <Button
            primary
            busy={saving}
            disabled={step === 0 && !draftComplete(draft)}
            onPress={() => (last ? void finish() : next())}
          >
            {last ? (mode === "first-run" ? "Finish setup" : "Save profile") : "Continue"}
          </Button>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 3, paddingVertical: 7 }}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.text}>{value}</Text>
    </View>
  );
}

/**
 * Settings: every profile field, the current saved values, and a way back into
 * guided setup. Saves through `PUT /api/agent/profile`.
 */
export function ProfileSettings() {
  const { profile, onboarded, loaded, error, saving, save, startEditing, refresh } = useProfile();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(profile));
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!editing) setDraft(draftFromProfile(profile));
  }, [profile, editing]);
  const update = (patch: Partial<ProfileDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  async function commit() {
    if (!draftComplete(draft)) {
      setProblem("Enter your name to save.");
      return;
    }
    setProblem("");
    setNotice("");
    try {
      await save(profileInputFromDraft(draft));
      setEditing(false);
      setNotice("Profile saved.");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }
  if (!loaded)
    return (
      <Card style={{ gap: 10 }}>
        <Text style={s.heading}>Your profile</Text>
        {error ? (
          <>
            <ErrorNotice error={error} />
            <Button small onPress={() => void refresh().catch(() => {})}>
              Try again
            </Button>
          </>
        ) : (
          <ActivityIndicator color={colors.blueDark} />
        )}
      </Card>
    );
  return (
    <Card style={{ gap: 10 }}>
      <View style={[s.between, { gap: 10 }]}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={s.heading}>Your profile & area</Text>
          <Text style={s.muted}>
            Who you are and where you play. The tournament tools use this instead of any built-in
            assumption.
          </Text>
        </View>
      </View>
      {!onboarded && (
        <Text style={[s.text, { color: colors.danger }]}>
          Setup is not finished. Add your name so the agent knows who it works for.
        </Text>
      )}
      {editing ? (
        <>
          <Field
            label="Your name"
            value={draft.displayName}
            onChangeText={(displayName) => update({ displayName })}
            placeholder="Your name"
          />
          <Field
            label="USATT number (optional)"
            value={draft.usattId}
            onChangeText={(usattId) => update({ usattId })}
            placeholder="Your USATT id"
            autoCapitalize="none"
          />
          <Field
            label="Home region (optional)"
            value={draft.homeRegion}
            onChangeText={(homeRegion) => update({ homeRegion })}
            placeholder="A region number or label"
          />
          <Field
            label="Cities (optional)"
            value={draft.cities}
            onChangeText={(cities) => update({ cities })}
            placeholder="Cities, separated by commas"
          />
          <Field
            label="States (optional)"
            value={draft.states}
            onChangeText={(states) => update({ states })}
            placeholder="States, separated by commas"
          />
          <Field
            label="Clubs (optional)"
            value={draft.clubs}
            onChangeText={(clubs) => update({ clubs })}
            placeholder="Clubs you play at"
          />
          <Field
            label="League or tournament links (optional)"
            value={draft.leagueUrls}
            onChangeText={(leagueUrls) => update({ leagueUrls })}
            placeholder="One link per line"
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={[s.row, { gap: 8 }]}>
            <Button primary busy={saving} onPress={() => void commit()}>
              Save profile
            </Button>
            <Button
              small
              onPress={() => {
                setEditing(false);
                setProblem("");
                setDraft(draftFromProfile(profile));
              }}
            >
              Cancel
            </Button>
          </View>
        </>
      ) : (
        <View style={{ gap: 2 }}>
          <SettingRow label="Name" value={showValue(profile?.displayName)} />
          <SettingRow label="USATT number" value={showValue(profile?.usattId)} />
          <SettingRow label="Home region" value={showValue(profile?.homeRegion)} />
          <SettingRow label="Cities" value={showValue(profile?.cities)} />
          <SettingRow label="States" value={showValue(profile?.states)} />
          <SettingRow label="Clubs" value={showValue(profile?.clubs)} />
          <SettingRow label="League links" value={showValue(profile?.leagueUrls)} />
          <View style={[s.row, { gap: 8, marginTop: 8, flexWrap: "wrap" }]}>
            <Button primary onPress={() => setEditing(true)}>
              Edit profile
            </Button>
            <Button onPress={startEditing}>Run guided setup again</Button>
          </View>
        </View>
      )}
      {!!notice && <Text style={[s.small, { color: colors.blueDark }]}>{notice}</Text>}
      <ErrorNotice error={problem} />
      {!!error && <ErrorNotice error={error} />}
    </Card>
  );
}
