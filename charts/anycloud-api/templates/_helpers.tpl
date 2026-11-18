{{- define "anycloud-api.labels" -}}
app.kubernetes.io/name: anycloud-api
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
anycloud.sh/system-release: 'true'
{{- end -}}

{{- define "anycloud-api.selector" -}}
app.kubernetes.io/name: anycloud-api
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "anycloud-api.releaseAnnotations" -}}
anycloud.sh/release-revision: {{ .Values.release.revision | quote }}
anycloud.sh/release-operation: {{ .Values.release.operationId | quote }}
anycloud.sh/api-version: {{ .Values.release.version | quote }}
{{- /* Any chart change rolls the Pod: an upgrade that moves chart and image
together rolls it once, and a later chart-only Helm run would show. */}}
anycloud.sh/chart-version: {{ .Chart.Version | quote }}
{{- end -}}

{{- define "anycloud-api.requireValues" -}}
{{- if not (regexMatch "@sha256:[a-f0-9]{64}$" .Values.release.image) -}}
{{- fail "release.image must be a digest-pinned reference" -}}
{{- end -}}
{{- if le (int .Values.release.revision) 0 -}}
{{- fail "release.revision must be a positive integer" -}}
{{- end -}}
{{- if not .Values.release.operationId -}}
{{- fail "release.operationId is required" -}}
{{- end -}}
{{- if not .Values.installation.id -}}
{{- fail "installation.id is required" -}}
{{- end -}}
{{- if not .Values.installation.ownerUsername -}}
{{- fail "installation.ownerUsername is required" -}}
{{- end -}}
{{- if not (regexMatch "^[1-9][0-9]*$" (toString .Values.installation.ownerUserId)) -}}
{{- fail "installation.ownerUserId must be a positive integer" -}}
{{- end -}}
{{- if not (hasPrefix "http" .Values.installation.apiUrl) -}}
{{- fail "installation.apiUrl must be an externally reachable HTTP(S) origin" -}}
{{- end -}}
{{- if not .Values.cluster.name -}}
{{- fail "cluster.name is required" -}}
{{- end -}}
{{- if not .Values.cluster.kubernetesIdentity -}}
{{- fail "cluster.kubernetesIdentity is required" -}}
{{- end -}}
{{- if not (hasPrefix "https://" .Values.cluster.joinEndpoint) -}}
{{- fail "cluster.joinEndpoint must be the public https control-plane endpoint" -}}
{{- end -}}
{{- if not .Values.cluster.certificateAuthorityData -}}
{{- fail "cluster.certificateAuthorityData is required" -}}
{{- end -}}
{{- if ne .Values.ingress.mode "traefik" -}}
{{- fail (printf "ingress.mode %q is not a qualified API route" .Values.ingress.mode) -}}
{{- end -}}
{{- if not (regexMatch "^[a-z0-9.-]+$" .Values.ingress.host) -}}
{{- fail "ingress.host must be the installation's DNS hostname" -}}
{{- end -}}
{{- end -}}
