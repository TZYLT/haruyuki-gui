/**
 * Sample page.
 *
 * Its job is to be the integration proof: every component, both locales, and the
 * token layer, assembled the way a real page would. If the pieces did not actually
 * compose, this page would be the first place that showed.
 *
 * It is deliberately not a test. The component tests assert behaviour one component
 * at a time; this page is what a human opens to see whether ten correct components
 * look like a coherent surface, which is a judgement no assertion replaces.
 *
 * The locale is a prop rather than internal state: the page is a preview, and a
 * preview that owned its own locale could not be rendered in two languages side by
 * side.
 */

import { useState, type ReactElement } from "react";

import {
  Alert,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  LocaleProvider,
  Select,
  Skeleton,
  Switch,
  Tag,
  useT,
} from "../index.js";

/** Props of {@link SamplePage}. */
export interface SamplePageProps {
  /** Locale tag for the whole subtree. */
  locale: string;
}

/** The options the sample select offers. */
const SAMPLE_OPTIONS = [
  { value: "md", label: "Markdown" },
  { value: "json", label: "JSON" },
  { value: "txt", label: "Plain text" },
];

/**
 * The body of the sample, inside a provider.
 *
 * Split from the exported component so `useT` has a provider above it -- a hook
 * called in the same component that renders the provider would see no context.
 *
 * @returns the sample content
 */
function SampleContent(): ReactElement {
  const t = useT();
  const [text, setText] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [format, setFormat] = useState<string | null>("md");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 720 }}>
      <section>
        <h3>{t("common.action.save")}</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" iconLeft="delete">
            Delete
          </Button>
          <Button loading>Loading</Button>
          <Button disabled>Disabled</Button>
        </div>
      </section>

      <section>
        <h3>{t("component.input.placeholder")}</h3>
        <Input
          value={text}
          onChange={setText}
          placeholder={t("component.input.placeholder")}
          prefix={<span>@</span>}
        />
        <div style={{ marginTop: 8 }}>
          <Input
            value=""
            onChange={() => undefined}
            invalid
            placeholder={t("component.form.required")}
          />
        </div>
      </section>

      <section>
        <h3>{t("component.select.placeholder")}</h3>
        <Select
          value={format}
          onChange={setFormat}
          options={SAMPLE_OPTIONS}
          labelKey="component.select.placeholder"
        />
        <div style={{ marginTop: 12 }}>
          <Switch checked={enabled} onChange={setEnabled} label={t("common.action.confirm")} />
        </div>
      </section>

      <section>
        <h3>{t("common.state.empty")}</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Tag text="Neutral" />
          <Tag text="Accent" tone="accent" />
          <Tag text="Danger" tone="danger" onClose={() => undefined} />
          <Tag text="Success" tone="success" />
        </div>
      </section>

      {dismissed ? null : (
        <Alert tone="warning" title={t("error.unexpected")} onDismiss={() => setDismissed(true)}>
          {t("page.conversation.retryLater")}
        </Alert>
      )}

      <Alert tone="info">{t("common.state.loading")}</Alert>

      <section>
        <h3>{t("common.state.loading")}</h3>
        <Skeleton count={3} height={20} />
      </section>

      <section>
        <EmptyState
          title={t("page.conversation.empty.title")}
          description={t("page.conversation.empty.description")}
          action={<Button variant="secondary">{t("common.action.confirm")}</Button>}
        />
      </section>

      <section>
        <ErrorState
          title={t("error.network.unreachable")}
          detail={t("error.withCode", { code: "E42" })}
          onRetry={() => undefined}
        />
      </section>

      <section>
        <Button variant="secondary" onClick={() => setDialogOpen(true)} data-testid="open-dialog">
          {t("component.dialog.title")}
        </Button>
        <Dialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title={t("component.dialog.title")}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialogOpen(false)}>
                {t("common.action.cancel")}
              </Button>
              <Button variant="danger" onClick={() => setDialogOpen(false)}>
                {t("common.action.delete")}
              </Button>
            </>
          }
        >
          {t("common.state.error")}
        </Dialog>
      </section>
    </div>
  );
}

/**
 * The sample page.
 *
 * @param props locale to render in
 * @returns the page
 */
export function SamplePage({ locale }: SamplePageProps): ReactElement {
  return (
    <LocaleProvider locale={locale}>
      <SampleContent />
    </LocaleProvider>
  );
}
