{{- define "papercrate.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "papercrate.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "papercrate.labels" -}}
app.kubernetes.io/name: {{ include "papercrate.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- range $key, $value := .Values.global.labels }}
{{ $key }}: {{ $value | quote }}
{{- end }}
{{- end -}}

{{- define "papercrate.selectorLabels" -}}
app.kubernetes.io/name: {{ include "papercrate.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "papercrate.image" -}}
{{- $registry := .Values.global.imageRegistry -}}
{{- $repository := .image.repository -}}
{{- if $registry }}
{{- printf "%s/%s" $registry $repository -}}
{{- else -}}
{{- $repository -}}
{{- end -}}
{{- end -}}

{{- define "papercrate.backend.image" -}}
{{- include "papercrate.image" (dict "Values" .Values "image" .Values.backend.image) -}}
{{- end -}}

{{- define "papercrate.webdav.image" -}}
{{- include "papercrate.image" (dict "Values" .Values "image" .Values.webdav.image) -}}
{{- end -}}

{{- define "papercrate.frontend.image" -}}
{{- include "papercrate.image" (dict "Values" .Values "image" .Values.frontend.image) -}}
{{- end -}}

{{- define "papercrate.quickwit.image" -}}
{{- include "papercrate.image" (dict "Values" .Values "image" .Values.quickwit.image) -}}
{{- end -}}

{{- define "papercrate.postgres.image" -}}
{{- include "papercrate.image" (dict "Values" .Values "image" .Values.postgres.image) -}}
{{- end -}}

{{- define "papercrate.image.tag" -}}
{{- if .image.tag -}}
{{- .image.tag -}}
{{- else -}}
{{- .Chart.AppVersion -}}
{{- end -}}
{{- end -}}
