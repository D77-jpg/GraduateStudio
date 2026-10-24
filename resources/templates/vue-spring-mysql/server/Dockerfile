# syntax=docker/dockerfile:1
FROM maven:3.9-eclipse-temurin-17 AS build
ARG MAVEN_MIRROR=""
WORKDIR /app
RUN if [ -n "$MAVEN_MIRROR" ]; then printf '<settings><mirrors><mirror><id>m</id><mirrorOf>central</mirrorOf><url>%s</url></mirror></mirrors></settings>' "$MAVEN_MIRROR" > /opt/settings.xml; fi
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 S=""; [ -f /opt/settings.xml ] && S="-s /opt/settings.xml"; mvn -B -ntp $S dependency:go-offline || true
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 S=""; [ -f /opt/settings.xml ] && S="-s /opt/settings.xml"; mvn -B -ntp $S -DskipTests package

FROM eclipse-temurin:17-jre-jammy
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/app.jar /app/app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
