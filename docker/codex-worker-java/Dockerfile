# Codex worker with a Java toolchain, so the agent can compile and test Spring Boot code
# inside a module (the inner write → compile → fix loop). Still runs with --network none:
# Maven resolves artifacts offline from the shared gs-gate-cache volume (/cache/m2),
# which the delivery gate warms on its first online build of the skeleton.
#
# Build (after building docker/codex-worker):
#   docker build -t gs-codex-worker-java:0.150.1 docker/codex-worker-java
FROM gs-codex-worker:0.150.1
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk-headless maven \
    && rm -rf /var/lib/apt/lists/* \
    && java -version && mvn -v
USER 10001:10001
ENV JAVA_TOOL_OPTIONS="-Dfile.encoding=UTF-8"
