{{/* Chart name, truncated to the 63 character DNS label limit. */}}
{{- define "hdhomerun-signal.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "hdhomerun-signal.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "hdhomerun-signal.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Selector labels must stay stable across upgrades: name and instance only. */}}
{{- define "hdhomerun-signal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "hdhomerun-signal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "hdhomerun-signal.labels" -}}
helm.sh/chart: {{ include "hdhomerun-signal.chart" . }}
{{ include "hdhomerun-signal.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "hdhomerun-signal.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "hdhomerun-signal.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Image reference: digest wins over tag, tag defaults to appVersion. */}}
{{- define "hdhomerun-signal.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end }}

{{/* Fail early on combinations that cannot work or defeat the isolation model. */}}
{{- define "hdhomerun-signal.validate" -}}
{{- if and .Values.hdhomerun.discovery.enabled (not .Values.hostNetwork) -}}
{{- fail "hdhomerun.discovery.enabled requires hostNetwork: true (broadcast discovery cannot cross the pod network)" -}}
{{- end -}}
{{- if and (not .Values.hdhomerun.devices) (not .Values.hdhomerun.discovery.enabled) -}}
{{- fail "set hdhomerun.devices to your tuner IPs, or enable hostNetwork and hdhomerun.discovery.enabled" -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not .Values.ingress.tls) (not .Values.ingress.allowInsecure) -}}
{{- fail "ingress.enabled requires ingress.tls (the app has no authentication); set ingress.allowInsecure=true to override" -}}
{{- end -}}
{{- end }}
