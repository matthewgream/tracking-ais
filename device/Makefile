
SYSTEM = ais
HOSTNAME=$(shell hostname)
TARGET = device

listen:
	mosquitto_sub -t "ais/#"
test:
	./device.wrapper ./device.$(HOSTNAME).cfg

.PHONY: listen test

##

SYSTEMD_DIR = /etc/systemd/system
define install_systemd_service
	-systemctl stop $(1) 2>/dev/null || true
	-systemctl disable $(1) 2>/dev/null || true
	cp $(2).service $(SYSTEMD_DIR)/$(1).service
	systemctl daemon-reload
	systemctl enable $(1)
	systemctl start $(1) || echo "Warning: Failed to start $(1)"
endef
install_systemd_service: $(TARGET).service
	$(call install_systemd_service,$(SYSTEM)-$(TARGET),$(TARGET))
install_udev:
	cp 90-*.rules /etc/udev/rules.d
	udevadm control --reload-rules
	udevadm trigger
install: install_udev install_systemd_service
.PHONY: install install_udev install_systemd_service

