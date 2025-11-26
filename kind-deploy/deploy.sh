#!/bin/bash

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

bold() { echo -e "\033[1m$@\033[0m"; }

set -e

bold "${CYAN}Creating Kind cluster...${NC}"
kind create cluster --name kind-cluster --config kind-cluster.yml

echo
bold "${CYAN}Cluster info:${NC}"
kubectl cluster-info --context kind-kind-cluster

echo
bold "${CYAN}K8s nodes:${NC}"
kubectl get nodes -o wide

echo
bold "${YELLOW}Applying infrastructure manifests...${NC}"
kubectl apply -f infra-deployments.yaml

bold "${YELLOW}Applying secrets...${NC}"
kubectl apply -f secrets.yaml

bold "${GREEN}Waiting for infrastructure to settle (sleep 30s)...${NC}"
sleep 30

bold "${YELLOW}Running DB migration and seed job...${NC}"
kubectl apply -f ./jobs/db-migrate.yaml

bold "${CYAN}Waiting for db-migrate job to finish (sleep 120s)...${NC}"
sleep 120

echo
bold "${CYAN}DB migration job logs:${NC}"
kubectl logs job/db-migrate

echo
cd deployments

bold "${CYAN}Deploying API...${NC}"
kubectl apply -f api-deployment.yaml

bold "${CYAN}Deploying Frontend...${NC}"
kubectl apply -f fe-deployment.yaml

bold "${CYAN}Deploying Producer...${NC}"
kubectl apply -f producer-deployment.yaml

bold "${CYAN}Deploying Consumer...${NC}"
kubectl apply -f consumer-deployment.yaml

bold "${GREEN}Waiting for workloads to settle (sleep 180s)...${NC}"
sleep 180

echo
bold "${CYAN}Getting all pods...${NC}"
kubectl get pods

bold "${CYAN}FE Service info:${NC}"
kubectl get service fe-service

bold "${YELLOW}Port forwarding front-end (runs in new terminal)...${NC}"
gnome-terminal -- bash -c "kubectl port-forward service/fe-service 3000:3000; exec bash" || \
x-terminal-emulator -e "kubectl port-forward service/fe-service 3000:3000"
sleep 5

bold "${YELLOW}Port forwarding API (runs in new terminal)...${NC}"
gnome-terminal -- bash -c "kubectl port-forward service/api-service 3001:3001; exec bash" || \
x-terminal-emulator -e "kubectl port-forward service/api-service 3001:3001"
sleep 5

bold "${GREEN}Checking API health:${NC}"
curl http://localhost:3001/health

echo
bold "${GREEN}Cluster bootstrap complete!${NC}"
